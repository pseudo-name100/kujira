const fs = require("fs");
const path = require("path");
const { getAddress, solidityPackedKeccak256 } = require("ethers");
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

/**
 * Hidden snapshot blocks for a holding round: the window [fromBlock, toBlock) is cut into
 * `count` equal parts and one block is picked inside each, from `seed` (the hash of a block
 * at or after the window's end, so nobody can know the picks while the window is open, and
 * anyone can recompute them afterwards).
 */
function snapshotBlocks(seed, fromBlock, toBlock, count) {
  const len = Math.floor((toBlock - fromBlock) / count);
  if (len < 1) throw new Error("snapshot window too short");
  return Array.from({ length: count }, (_, i) => {
    const r = BigInt(solidityPackedKeccak256(["bytes32", "uint256"], [seed, i]));
    return fromBlock + i * len + Number(r % BigInt(len));
  });
}

/**
 * Scores holders across snapshots. `snaps` is one Map per snapshot of address ->
 * { wallet, staked, boosted } (bigints; Pod `boosted` is the stake times its boost).
 * A wallet qualifies if it held at least `minHeld` (wallet + Pod) at every snapshot. At each
 * snapshot its value is what it held, counted up to `cap`, times its blended Pod boost
 * (1x for wallet KUJI); its weight is the lowest value across snapshots, so buying in for a
 * day or selling in between both cost the wallet.
 */
function holdingWeights(snaps, { minHeld, cap }) {
  const BPS = 10_000n;
  const addresses = new Set(snaps.flatMap((m) => [...m.keys()]));
  const rows = [];
  for (const address of addresses) {
    let lowestHeld = null, weight = null;
    for (const m of snaps) {
      const { wallet = 0n, staked = 0n, boosted = 0n } = m.get(address) || {};
      const held = wallet + staked;
      const mult = held === 0n ? BPS : ((wallet + boosted) * BPS) / held;
      const value = ((cap && held > cap ? cap : held) * mult) / BPS;
      if (lowestHeld === null || held < lowestHeld) lowestHeld = held;
      if (weight === null || value < weight) weight = value;
    }
    if (lowestHeld >= minHeld && weight > 0n) rows.push({ address, lowestHeld, weight });
  }
  return rows.sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : a.address.localeCompare(b.address)));
}

/**
 * Scores KUJI buyers: `bought` maps address -> KUJI received from the pool; `snaps` are
 * hidden-snapshot Maps of address -> { wallet, staked } (Pod KUJI counts as held). A buyer
 * qualifies with at least `minBought`, and counts at the smallest of what it bought, the
 * least it held at any snapshot, and `cap`: buying and dumping, or buying after the
 * snapshots, earns nothing.
 */
function buyerWeights(bought, snaps, { minBought, cap }) {
  const rows = [];
  for (const [address, amount] of bought) {
    if (amount < minBought) continue;
    let lowest = null;
    for (const m of snaps) {
      const { wallet = 0n, staked = 0n } = m.get(address) || {};
      const held = wallet + staked;
      if (lowest === null || held < lowest) lowest = held;
    }
    let weight = amount < lowest ? amount : lowest;
    if (cap && weight > cap) weight = cap;
    if (weight > 0n) rows.push({ address, bought: amount, lowestHeld: lowest, weight });
  }
  return rows.sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : a.address.localeCompare(b.address)));
}

/**
 * Drop sign-ups from Privy's user records (GET /api/v1/users). Counts a user who linked an X
 * account by `until` (unix seconds), once per X account and once per wallet, paid to their
 * own Ethereum wallet if they connected one (the earliest), else the wallet Privy made for
 * them. Must match dropWallet() in wallet/src/privy.jsx.
 */
function signupsFromPrivyUsers(users, { until, exclude = [] }) {
  const skip = new Set(exclude.filter(Boolean).map((a) => getAddress(a)));
  const seenX = new Set(), seenWallet = new Set(), out = [];
  const sorted = [...users].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  for (const u of sorted) {
    const acc = u.linked_accounts || [];
    const x = acc.find((a) => a.type === "twitter_oauth");
    if (!x || seenX.has(x.subject)) continue;
    const xAt = x.first_verified_at ?? x.verified_at ?? Infinity;
    if (xAt > until) continue;
    const wallets = acc
      .filter((a) => a.type === "wallet" && (a.chain_type ?? "ethereum") === "ethereum" && a.address)
      .sort((a, b) => (a.first_verified_at ?? a.verified_at ?? 0) - (b.first_verified_at ?? b.verified_at ?? 0));
    const w = wallets.find((a) => a.wallet_client_type !== "privy") || wallets.find((a) => a.wallet_client_type === "privy");
    if (!w) continue;
    const address = getAddress(w.address);
    if (skip.has(address) || seenWallet.has(address)) continue;
    seenX.add(x.subject);
    seenWallet.add(address);
    out.push({ address, x: x.username || x.subject });
  }
  return out;
}

/** Add up allocations from several lists, one row per address. */
function mergeAllocations(...lists) {
  const sum = new Map();
  for (const list of lists) for (const a of list) sum.set(getAddress(a.address), (sum.get(getAddress(a.address)) || 0n) + a.amount);
  return [...sum].map(([address, amount]) => ({ address, amount })).filter((a) => a.amount > 0n);
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

module.exports = { roundDir, mergeHolders, snapshotBlocks, holdingWeights, buyerWeights, mergeAllocations, signupsFromPrivyUsers, allocateWeighted, createAggregator, aggregateTraders, filterTraders, allocate, buildTree, writeCsv, readCsv };
