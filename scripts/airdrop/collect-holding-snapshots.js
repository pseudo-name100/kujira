// Usage: node scripts/airdrop/collect-holding-snapshots.js <round>
// For holding rounds (config `snapshots`): reads every candidate's wallet balance, Pod stake
// and Pod boost at `count` hidden blocks inside the announced window, scores them with
// holdingWeights (lowest across snapshots, Pod boost counted, capped), and sizes the round
// from what the Drop has free. Writes airdrop/round-<n>/holders.csv and snapshot.json.
//
// The blocks come from the hash of the first block at or after the window's end, so they
// can't be known while the window is open and anyone can recompute them afterwards.
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Contract, Interface, id, getAddress, formatEther } = require("ethers");
const { rounds } = require("./config");
const { roundDir, snapshotBlocks, holdingWeights, writeCsv } = require("./lib");

const RPC = process.env.INK_RPC_URL || "https://rpc-gel.inkonchain.com";
const EXPLORER = "https://explorer.inkonchain.com";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
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

// The first block with timestamp >= t (Ink makes a block every second or so).
async function blockAtTime(provider, t) {
  const head = await provider.getBlock("latest");
  if (head.timestamp < t) throw new Error(`${new Date(t * 1000).toISOString()} hasn't happened on-chain yet`);
  let lo = 0, hi = head.number;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await provider.getBlock(mid)).timestamp < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function currentHolders(token) {
  const out = [];
  let params = {};
  for (;;) {
    const page = await getJson(`${EXPLORER}/api/v2/tokens/${token}/holders?${new URLSearchParams(params)}`);
    for (const it of page.items || []) out.push(getAddress(it.address.hash));
    if (!page.next_page_params) break;
    params = page.next_page_params;
    await sleep(250);
  }
  return out;
}

// Everyone on either side of a KUJI transfer (stakes and withdrawals included) since `fromBlock`.
async function movedSince(token, fromBlock) {
  const seen = new Set();
  for (let page = 1; ; page++) {
    const r = await getJson(
      `${EXPLORER}/api?module=logs&action=getLogs&address=${token}&topic0=${TRANSFER}` +
        `&fromBlock=${fromBlock}&toBlock=latest&page=${page}&offset=1000`
    );
    const logs = Array.isArray(r.result) ? r.result : [];
    for (const l of logs) {
      seen.add(getAddress("0x" + l.topics[1].slice(26)));
      seen.add(getAddress("0x" + l.topics[2].slice(26)));
    }
    if (logs.length < 1000) break;
    await sleep(250);
  }
  return [...seen];
}

// wallet, staked and boosted for every address at one block, batched through Multicall3.
async function readAt(provider, block, addresses, d) {
  const erc = new Interface(["function balanceOf(address) view returns (uint256)"]);
  const pod = new Interface([
    "function balanceOf(address) view returns (uint256)",
    "function boostedBalanceOf(address) view returns (uint256)",
  ]);
  const mc = new Contract(
    MULTICALL3,
    ["function aggregate3((address target,bool allowFailure,bytes callData)[]) view returns ((bool success,bytes returnData)[])"],
    provider
  );
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const calls = chunk.flatMap((a) => [
      { target: d.KujiraToken, allowFailure: false, callData: erc.encodeFunctionData("balanceOf", [a]) },
      { target: d.KujiraPod, allowFailure: false, callData: pod.encodeFunctionData("balanceOf", [a]) },
      { target: d.KujiraPod, allowFailure: false, callData: pod.encodeFunctionData("boostedBalanceOf", [a]) },
    ]);
    const res = await mc.aggregate3(calls, { blockTag: block });
    chunk.forEach((a, j) => {
      const [wallet, staked, boosted] = res.slice(j * 3, j * 3 + 3).map((r) => BigInt(r.returnData));
      if (wallet + staked > 0n) out.set(a, { wallet, staked, boosted });
    });
  }
  return out;
}

async function main() {
  const round = process.argv[2];
  const cfg = rounds[round];
  if (!cfg?.snapshots) throw new Error(`round ${round} has no snapshots config`);
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "deployments", "ink.json"), "utf8"));
  const provider = new JsonRpcProvider(RPC, 57073, { staticNetwork: true });

  const { count, from, to } = cfg.snapshots;
  const fromBlock = await blockAtTime(provider, Date.parse(from) / 1000);
  const endBlock = await blockAtTime(provider, Date.parse(to) / 1000);
  const seed = (await provider.getBlock(endBlock)).hash;
  const blocks = snapshotBlocks(seed, fromBlock, endBlock, count);
  console.log(`Window ${from} to ${to}: blocks ${fromBlock}-${endBlock}, seed ${seed} (block ${endBlock})`);
  console.log(`Snapshots at blocks ${blocks.join(", ")}`);

  // Anyone who could qualify: everyone holding KUJI now, plus everyone who moved KUJI since
  // the first snapshot (a wallet that didn't move held the same amount at every snapshot).
  const moved = new Set(await movedSince(d.KujiraToken, blocks[0]));
  const holders = (await currentHolders(d.KujiraToken)).filter((a) => !moved.has(a));
  // A holder who hasn't moved KUJI since the first snapshot held today's amount at every one.
  const now = await readAt(provider, "latest", holders, d);
  const steady = holders.filter((a) => {
    const h = now.get(a);
    return h && h.wallet + h.staked >= cfg.eligibility.minHeld;
  });
  const candidates = new Set([...steady, ...moved]);
  const exclude = new Set(
    [d.KujiraToken, d.KujiraPod, d.KujiraDrop, d.KujiraLiquidityLock, d.launch?.pool, d.deployer, d.liquidity, d.feeRecipient, ...BURN, ...(cfg.eligibility?.exclude || [])]
      .filter(Boolean)
      .map((a) => getAddress(a))
  );
  const list = [];
  for (const a of candidates) {
    if (exclude.has(a)) continue;
    if ((await provider.getCode(a)) !== "0x") continue; // pools, routers and other contracts
    list.push(a);
  }
  console.log(`${list.length} candidate wallets`);

  const snaps = [];
  for (const b of blocks) snaps.push(await readAt(provider, b, list, d));
  const rows = holdingWeights(snaps, { minHeld: cfg.eligibility.minHeld, cap: cfg.weightCap });

  // Size: what the Drop has free, minus what's kept for later rounds, leaving room for the
  // stake bonus. 50M when round 1 was fully claimed; more with its leftovers and any
  // launch-tax KUJI sent to the Drop.
  const drop = new Contract(d.KujiraDrop, ["function available() view returns (uint256)"], provider);
  const available = await drop.available();
  const free = available > cfg.sizeFromPool.keep ? available - cfg.sizeFromPool.keep : 0n;
  const total = (free * 10_000n) / (10_000n + BigInt(cfg.stakeBonusBps));
  console.log(`Drop has ${formatEther(available)} KUJI free; round ${round} total ${formatEther(total)} KUJI`);

  const dir = roundDir(round);
  fs.mkdirSync(dir, { recursive: true });
  writeCsv(
    path.join(dir, "holders.csv"),
    ["address", "lowestHeld", "weight"],
    rows.map((r) => ({ address: r.address, lowestHeld: formatEther(r.lowestHeld), weight: formatEther(r.weight) }))
  );
  fs.writeFileSync(
    path.join(dir, "snapshot.json"),
    JSON.stringify(
      { network: "ink", window: { from, to, fromBlock, endBlock }, seed, blocks, dropAvailable: available.toString(), total: total.toString() },
      null,
      2
    ) + "\n"
  );
  console.log(`${rows.length} wallets held ${formatEther(cfg.eligibility.minHeld)}+ at every snapshot`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { readAt, blockAtTime };
