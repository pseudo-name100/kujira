// Usage: node scripts/airdrop/discover-routers.js <round>
// Finds the DEX routers Ink traders actually use, so the collector doesn't depend on a
// hand-written list. It samples Uniswap v2/v3/v4 and Velodrome swap events in slices
// spread over the round's window, groups the swap transactions by the contract they
// were sent to, and keeps contracts that
//   - many different wallets used (private bot contracts have a handful of senders), and
//   - mostly do swaps (games, bridges and bot wallets do other things too).
// Writes airdrop/round-<n>/routers.json for review.
const fs = require("fs");
const path = require("path");
const { id, getAddress } = require("ethers");
const { rpcUrl, explorerApi, rounds } = require("./config");
const { roundDir } = require("./lib");

const SWAP_TOPICS = [
  id("Swap(address,uint256,uint256,uint256,uint256,address)"), // Uniswap v2 style
  id("Swap(address,address,int256,int256,uint160,uint128,int24)"), // Uniswap v3 / Slipstream
  id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"), // Uniswap v4
  id("Swap(address,address,uint256,uint256,uint256,uint256)"), // Velodrome v2 style
];
const ENTRYPOINT = "0x0000000071727De22E5E9d8BAF0edAc6f37da032"; // ERC-4337: sender is a bundler
const MAX_LOG_RANGE = 1000; // Ink public RPC limit for eth_getLogs

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 5) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { accept: "application/json" } }).catch(() => null);
    if (res?.ok) return res.json();
    if (i >= tries) throw new Error(`${res?.status ?? "network error"} for ${url}`);
    await sleep(1000 * 2 ** i);
  }
}

async function rpc(body, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      if (i >= tries) throw new Error(`RPC ${res.status}`);
    } catch (e) {
      if (i >= tries) throw e;
    }
    await sleep(1000 * 2 ** i);
  }
}

// JSON-RPC batch that retries individual calls the node rejected (rate limits).
async function rpcBatch(calls, size = 25) {
  const out = new Array(calls.length);
  for (let i = 0; i < calls.length; i += size) {
    let pending = calls.slice(i, i + size).map((c, j) => ({ jsonrpc: "2.0", id: i + j, ...c }));
    for (let attempt = 1; pending.length > 0; attempt++) {
      if (attempt > 6) throw new Error(`RPC kept failing: ${pending[0].method}`);
      if (attempt > 1) await sleep(1000 * 2 ** attempt);
      const res = await rpc(pending);
      const list = Array.isArray(res) ? res : [];
      for (const r of list) if (r && r.result !== undefined && !r.error) out[r.id] = r.result;
      pending = pending.filter((c) => out[c.id] === undefined);
    }
  }
  return out;
}

const call = async (method, params) => (await rpcBatch([{ method, params }]))[0];

async function blockAt(timestamp, head) {
  let lo = 1, hi = head.number;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await call("eth_getBlockByNumber", ["0x" + mid.toString(16), false]);
    if (parseInt(b.timestamp, 16) < timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function main() {
  const round = process.argv[2];
  const cfg = rounds[round];
  if (!cfg) throw new Error(`no config for round ${round} in scripts/airdrop/config.js`);
  const e = cfg.eligibility;
  const d = e.discovery;

  const headRaw = await call("eth_getBlockByNumber", ["latest", false]);
  const head = { number: parseInt(headRaw.number, 16), timestamp: parseInt(headRaw.timestamp, 16) };
  const start = await blockAt(Date.parse(e.from) / 1000, head);
  const end = Math.min(await blockAt(Date.parse(e.to) / 1000 + 86400, head), head.number);

  // 1. Swap transactions in evenly spaced slices of the window
  const txs = new Set();
  const step = Math.floor((end - start) / d.slices);
  for (let s = 0; s < d.slices; s++) {
    const from = start + s * step;
    for (let b = from; b < from + d.blocksPerSlice; b += MAX_LOG_RANGE) {
      const logs = await call("eth_getLogs", [
        { fromBlock: "0x" + b.toString(16), toBlock: "0x" + (b + MAX_LOG_RANGE - 1).toString(16), topics: [SWAP_TOPICS] },
      ]);
      for (const l of logs) txs.add(l.transactionHash);
    }
    process.stdout.write(`\r  slice ${s + 1}/${d.slices}, ${txs.size} swap txs`);
  }
  process.stdout.write("\n");

  // 2. Group by the contract each swap transaction was sent to
  const byTarget = new Map();
  const hashes = [...txs];
  for (let i = 0; i < hashes.length; i += 100) {
    const res = await rpcBatch(hashes.slice(i, i + 100).map((h) => ({ method: "eth_getTransactionByHash", params: [h] })));
    for (const t of res) {
      if (!t || !t.to) continue;
      const to = getAddress(t.to);
      let g = byTarget.get(to);
      if (!g) byTarget.set(to, (g = { swapTxs: 0, senders: new Set() }));
      g.swapTxs += 1;
      g.senders.add(t.from.toLowerCase());
    }
  }

  // 3. Keep widely used contracts whose recent transactions are mostly swaps
  const routers = [];
  for (const [address, g] of byTarget) {
    if (g.senders.size < d.minSenders || address === ENTRYPOINT) continue;
    const page = await getJson(`${explorerApi}/addresses/${address}/transactions?filter=to`);
    const items = page.items || [];
    if (items.length === 0) continue;
    const receipts = await rpcBatch(items.map((t) => ({ method: "eth_getTransactionReceipt", params: [t.hash] })));
    const swaps = receipts.filter((r) => r.logs.some((l) => SWAP_TOPICS.includes(l.topics[0]))).length;
    const info = await getJson(`${explorerApi}/addresses/${address}`);
    const row = {
      name: info.name || "(unverified)",
      address,
      sampledWallets: g.senders.size,
      sampledSwapTxs: g.swapTxs,
      recentSwapShare: Number((swaps / items.length).toFixed(2)),
    };
    console.log(`  ${row.recentSwapShare >= d.minSwapShare ? "keep" : "skip"} ${address} ${row.name} wallets=${row.sampledWallets} swapShare=${row.recentSwapShare}`);
    if (row.recentSwapShare >= d.minSwapShare) routers.push(row);
    await sleep(200);
  }
  routers.sort((a, b) => b.sampledWallets - a.sampledWallets);

  const file = path.join(roundDir(round), "routers.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ window: { from: e.from, to: e.to, blocks: [start, end] }, discovery: d, routers }, null, 2) + "\n");
  console.log(`${routers.length} routers -> ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
