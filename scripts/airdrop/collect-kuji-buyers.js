// Usage: node scripts/airdrop/collect-kuji-buyers.js <round>
// For rounds with a `buyers` part: finds every wallet that bought KUJI from the launch pool
// between launch and the window's end, reads what each held (wallet + Pod) at hidden
// snapshots in that window, and scores them with buyerWeights. Writes
// airdrop/round-<n>/buyers.csv and buyers-snapshot.json.
//
// A buy is KUJI leaving the pool. When it lands in a contract (a router passing it on), it
// counts for the wallet that sent the transaction. The snapshots come from the hash of the
// block where the window ends, so nobody can know them while it's open.
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, id, getAddress, zeroPadValue, formatEther } = require("ethers");
const { rounds } = require("./config");
const { roundDir, snapshotBlocks, buyerWeights, writeCsv } = require("./lib");
const { readAt, blockAtTime } = require("./collect-holding-snapshots");

const RPC = process.env.INK_RPC_URL || "https://rpc-gel.inkonchain.com";
const EXPLORER = "https://explorer.inkonchain.com";
const TRANSFER = id("Transfer(address,address,uint256)");
const BURN = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 6) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { accept: "application/json" } }).catch(() => null);
    if (res?.ok) return res.json();
    if (i >= tries) throw new Error(`${res?.status ?? "network error"} for ${url}`);
    await sleep(1000 * 2 ** i);
  }
}

// The same, read straight from the chain in 1,000-block steps (Ink's RPC limit). Slower;
// used when LOGS_VIA_RPC=1 (the explorer is rate-limiting, or on a local fork).
async function buysFromPoolRpc(provider, token, pool, fromBlock, toBlock) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += 1000) {
    const logs = await provider.getLogs({
      address: token,
      topics: [TRANSFER, zeroPadValue(pool, 32)],
      fromBlock: start,
      toBlock: Math.min(start + 999, toBlock),
    });
    for (const l of logs) out.push({ to: getAddress("0x" + l.topics[2].slice(26)), value: BigInt(l.data), tx: l.transactionHash });
  }
  return out;
}

// Every KUJI transfer out of the pool between two blocks: { to, value, tx }.
async function buysFromPool(token, pool, fromBlock, toBlock) {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await getJson(
      `${EXPLORER}/api?module=logs&action=getLogs&address=${token}&topic0=${TRANSFER}` +
        `&topic1=${zeroPadValue(pool, 32)}&topic0_1_opr=and` +
        `&fromBlock=${fromBlock}&toBlock=${toBlock}&page=${page}&offset=1000`
    );
    const logs = Array.isArray(r.result) ? r.result : [];
    for (const l of logs) {
      if (getAddress("0x" + l.topics[1].slice(26)) !== getAddress(pool)) continue;
      out.push({ to: getAddress("0x" + l.topics[2].slice(26)), value: BigInt(l.data), tx: l.transactionHash });
    }
    if (logs.length < 1000) break;
    await sleep(250);
  }
  return out;
}

async function main() {
  const round = process.argv[2];
  const cfg = rounds[round];
  if (!cfg?.buyers) throw new Error(`round ${round} has no buyers config`);
  const b = cfg.buyers;
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "deployments", process.env.DEPLOYMENT || "ink.json"), "utf8"));
  if (!d.launch) throw new Error("KUJI hasn't launched: no pool in deployments/ink.json");
  const provider = new JsonRpcProvider(RPC, 57073, { staticNetwork: true });

  const launchBlock = (await provider.getTransactionReceipt(d.launch.tx)).blockNumber;
  const until = process.env.BUYERS_UNTIL || b.until; // override to move the window's end
  const endBlock = await blockAtTime(provider, Date.parse(until) / 1000);
  const seed = (await provider.getBlock(endBlock)).hash;
  const blocks = snapshotBlocks(seed, launchBlock, endBlock, b.snapshots);
  console.log(`Buys from launch (block ${launchBlock}) to ${until} (block ${endBlock}); seed ${seed}`);
  console.log(`Snapshots at blocks ${blocks.join(", ")}`);

  const skip = new Set(
    [d.KujiraToken, d.KujiraPod, d.KujiraDrop, d.KujiraLiquidityLock, d.launch.pool, d.deployer, d.liquidity, d.feeRecipient, ...BURN, ...(b.exclude || [])]
      .filter(Boolean)
      .map((a) => getAddress(a))
  );
  const bought = new Map();
  const codeCache = new Map();
  const isContract = async (a) => {
    if (!codeCache.has(a)) codeCache.set(a, (await provider.getCode(a)) !== "0x");
    return codeCache.get(a);
  };
  const buys = process.env.LOGS_VIA_RPC
    ? await buysFromPoolRpc(provider, d.KujiraToken, d.launch.pool, launchBlock, endBlock)
    : await buysFromPool(d.KujiraToken, d.launch.pool, launchBlock, endBlock);
  for (const buy of buys) {
    let who = buy.to;
    if (await isContract(who)) who = getAddress((await provider.getTransaction(buy.tx)).from); // via a router
    if (skip.has(who) || (await isContract(who))) continue;
    bought.set(who, (bought.get(who) || 0n) + buy.value);
  }
  console.log(`${buys.length} buys by ${bought.size} wallets`);

  const list = [...bought.keys()];
  const snaps = [];
  for (const blk of blocks) snaps.push(await readAt(provider, blk, list, d));
  const rows = buyerWeights(bought, snaps, { minBought: b.minBought, cap: b.cap });

  const dir = roundDir(round);
  fs.mkdirSync(dir, { recursive: true });
  writeCsv(
    path.join(dir, "buyers.csv"),
    ["address", "bought", "lowestHeld", "weight"],
    rows.map((r) => ({ address: r.address, bought: formatEther(r.bought), lowestHeld: formatEther(r.lowestHeld), weight: formatEther(r.weight) }))
  );
  fs.writeFileSync(
    path.join(dir, "buyers-snapshot.json"),
    JSON.stringify({ network: "ink", window: { from: "launch", until, launchBlock, endBlock }, seed, blocks, buys: buys.length }, null, 2) + "\n"
  );
  console.log(`${rows.length} buyers bought ${formatEther(b.minBought)}+ KUJI and held through every snapshot`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
