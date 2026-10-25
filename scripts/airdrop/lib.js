const fs = require("fs");
const path = require("path");
const { getAddress } = require("ethers");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");

const roundDir = (round) => path.join(__dirname, "..", "..", "airdrop", `round-${round}`);

/**
 * Counts swaps and active days per sender, one transaction at a time.
 * add() takes { hash, from, fromIsContract, timestamp, ok } as returned by the collector.
 */
function createAggregator({ from, to, exclude = [] }) {
  const start = Date.parse(from);
  const end = Date.parse(to) + 24 * 60 * 60 * 1000; // `to` is inclusive
  const skip = new Set(exclude.map((a) => getAddress(a)));
  const seen = new Set();
  const stats = new Map();

  return {
    add(tx) {
      if (!tx.ok || tx.fromIsContract || seen.has(tx.hash)) return;
      const t = Date.parse(tx.timestamp);
      if (!(t >= start && t < end)) return;
      const addr = getAddress(tx.from);
      if (skip.has(addr)) return;
      seen.add(tx.hash);

      let s = stats.get(addr);
      if (!s) stats.set(addr, (s = { swaps: 0, days: new Set() }));
      s.swaps += 1;
      s.days.add(tx.timestamp.slice(0, 10));
    },
    result() {
      return [...stats].map(([address, s]) => ({ address, swaps: s.swaps, activeDays: s.days.size }));
    },
  };
}

function aggregateTraders(txs, opts) {
  const agg = createAggregator(opts);
  for (const tx of txs) agg.add(tx);
  return agg.result();
}

function filterTraders(traders, { minSwaps, minActiveDays, maxSwaps }) {
  return traders
    .filter((t) => t.swaps >= minSwaps && t.activeDays >= minActiveDays && t.swaps <= maxSwaps)
    .sort((a, b) => b.activeDays - a.activeDays || b.swaps - a.swaps || a.address.localeCompare(b.address));
}

/** Split `total` (bigint wei) by weight = min(activeDays, maxWeightDays), rounding down. */
function allocate(traders, total, maxWeightDays) {
  const weights = traders.map((t) => BigInt(Math.min(t.activeDays, maxWeightDays)));
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new Error("no eligible traders");
  return traders
    .map((t, i) => ({ address: t.address, amount: (total * weights[i]) / sum }))
    .filter((a) => a.amount > 0n);
}

/**
 * Combine wallet balances and Pod stakes into one row per holder.
 * @param wallets [{ address, balance: bigint, isContract }]
 * @param stakes  [{ address, staked: bigint }]
 * @param exclude addresses to drop (contracts of the project, burn address, liquidity wallet...)
 */
function mergeHolders(wallets, stakes, exclude = []) {
  const skip = new Set(exclude.filter(Boolean).map((a) => getAddress(a)));
  const rows = new Map();
  const row = (a) => {
    const address = getAddress(a);
    if (!rows.has(address)) rows.set(address, { address, wallet: 0n, staked: 0n, isContract: false });
    return rows.get(address);
  };
  for (const w of wallets) Object.assign(row(w.address), { wallet: w.balance, isContract: Boolean(w.isContract) });
  for (const s of stakes) row(s.address).staked += s.staked;
  return [...rows.values()]
    .filter((r) => !skip.has(r.address) && !r.isContract)
    .map((r) => ({ address: r.address, wallet: r.wallet, staked: r.staked, held: r.wallet + r.staked }))
    .filter((r) => r.held > 0n)
    .sort((a, b) => (b.held > a.held ? 1 : b.held < a.held ? -1 : a.address.localeCompare(b.address)));
}

/** Split `total` (bigint) in proportion to each item's `weight` (bigint), rounding down. */
function allocateWeighted(items, total) {
  const sum = items.reduce((s, i) => s + i.weight, 0n);
  if (sum === 0n) throw new Error("nobody to allocate to");
  return items.map((i) => ({ address: i.address, amount: (total * i.weight) / sum })).filter((a) => a.amount > 0n);
}

function buildTree(allocations) {
  const tree = StandardMerkleTree.of(
    allocations.map((a) => [a.address, a.amount.toString()]),
    ["address", "uint256"]
  );
  const claims = {};
  for (const [i, [address, amount]] of tree.entries()) {
    claims[address] = { amount, proof: tree.getProof(i) };
  }
  const total = allocations.reduce((s, a) => s + a.amount, 0n);
  return { tree, root: tree.root, total, claims };
}

function writeCsv(file, header, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [header.join(","), ...rows.map((r) => header.map((h) => r[h]).join(","))].join("\n") + "\n");
}

function readCsv(file) {
  const [head, ...lines] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

module.exports = { roundDir, mergeHolders, allocateWeighted, createAggregator, aggregateTraders, filterTraders, allocate, buildTree, writeCsv, readCsv };
