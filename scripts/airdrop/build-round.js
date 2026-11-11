// Usage: node scripts/airdrop/build-round.js <round>
// Reads airdrop/round-<n>/traders.csv (DEX-trader rounds) or holders.csv (whale rounds),
// splits the round total (times `oversubscribe`), and writes:
//   allocations.csv  human-readable list to review and publish
//   claims.json      Merkle root, reserved total, and each wallet's amount + proof (for the claim page)
const fs = require("fs");
const path = require("path");
const { formatEther, parseEther } = require("ethers");
const { rounds } = require("./config");
const { roundDir, filterTraders, allocate, allocateWeighted, mergeAllocations, capWeighted, buildTree, readCsv, writeCsv } = require("./lib");

const round = process.argv[2];
const cfg = rounds[round];
if (!cfg) throw new Error(`no config for round ${round} in scripts/airdrop/config.js`);

const dir = roundDir(round);
// Holding rounds are sized from the Drop's free KUJI when the snapshots are read.
const roundTotal = cfg.sizeFromPool
  ? BigInt(JSON.parse(fs.readFileSync(path.join(dir, "snapshot.json"), "utf8")).total)
  : cfg.total;
const listedTarget = (roundTotal * BigInt(Math.round((cfg.oversubscribe ?? 1) * 100))) / 100n;

let allocations;
if (cfg.buyers) {
  // Round 1: KUJI buyers who held (weighted, from collect-kuji-buyers.js), plus even splits
  // among X sign-ups (collect-signups.js) and/or filtered Ink traders. Sums to exactly the
  // round total.
  const even = (file, share, rows, capEach) => {
    if (!share) return [];
    if (rows.length === 0) throw new Error(`${file} has no wallets in it`);
    let each = ((roundTotal * BigInt(share)) / 10_000n) / BigInt(rows.length);
    if (capEach && each > capEach) each = capEach;
    console.log(`${rows.length} wallets from ${file} get ${formatEther(each)} each`);
    return rows.map((r) => ({ address: r.address, amount: each }));
  };
  const signupPart = cfg.signupShareBps
    ? even("signups.csv", cfg.signupShareBps, readCsv(path.join(dir, "signups.csv")), cfg.signups?.capEach)
    : [];
  const traderPart = cfg.traderShareBps
    ? even("traders.csv", cfg.traderShareBps, filterTraders(
        readCsv(path.join(dir, "traders.csv")).map((t) => ({ address: t.address, swaps: Number(t.swaps), activeDays: Number(t.activeDays) })),
        cfg.eligibility
      ))
    : [];
  const buyers = readCsv(path.join(dir, "buyers.csv")).map((b) => ({ address: b.address, weight: parseEther(b.weight) }));
  if (buyers.length === 0) throw new Error("buyers.csv has no wallets in it");
  const buyerTotal = (roundTotal * BigInt(10_000 - (cfg.signupShareBps || 0) - (cfg.traderShareBps || 0))) / 10_000n;
  const buyerPart = cfg.buyers.matchBps ? capWeighted(buyers, buyerTotal, cfg.buyers.matchBps) : allocateWeighted(buyers, buyerTotal);
  allocations = mergeAllocations(buyerPart, signupPart, traderPart);
  const paid = buyerPart.reduce((s, a) => s + a.amount, 0n);
  console.log(`${buyers.length} KUJI buyers get ${formatEther(paid)} of ${formatEther(buyerTotal)}${cfg.buyers.matchBps ? ` (capped at ${cfg.buyers.matchBps / 100}% of what they held)` : ""}`);
} else if (cfg.source === "kuji-holders" && cfg.snapshots) {
  // Holding rounds: holders.csv already has each qualifying wallet's weight (lowest across
  // the hidden snapshots, Pod boost counted, capped); see collect-holding-snapshots.js.
  allocations = allocateWeighted(
    readCsv(path.join(dir, "holders.csv")).map((h) => ({ address: h.address, weight: parseEther(h.weight) })),
    listedTarget
  );
} else if (cfg.source === "kuji-holders") {
  // Whale rounds: holders at or above minHeld, shares by KUJI held (wallet + Pod),
  // counted up to weightCap so the very largest holder can't take the whole round.
  const cap = cfg.weightCap;
  const holders = readCsv(path.join(dir, "holders.csv"))
    .map((h) => ({ address: h.address, held: parseEther(h.held) }))
    .filter((h) => h.held >= cfg.eligibility.minHeld);
  allocations = cfg.amountEach
    ? holders.map((h) => ({ address: h.address, amount: cfg.amountEach }))
    : allocateWeighted(
        holders.map((h) => ({ address: h.address, weight: cap && h.held > cap ? cap : h.held })),
        listedTarget
      );
} else {
  // DEX-trader rounds. Re-apply the filters so config changes take effect without
  // collecting again.
  const traders = filterTraders(
    readCsv(path.join(dir, "traders.csv")).map((t) => ({
      address: t.address,
      swaps: Number(t.swaps),
      activeDays: Number(t.activeDays),
    })),
    cfg.eligibility
  );
  allocations = cfg.amountEach
    ? traders.map((t) => ({ address: t.address, amount: cfg.amountEach }))
    : allocate(traders, listedTarget, cfg.maxWeightDays);
}
const { root, total: listed, claims } = buildTree(allocations);
// The contract reserves this much; it can't be more than the list adds up to.
const total = listed < roundTotal ? listed : roundTotal;

writeCsv(
  path.join(dir, "allocations.csv"),
  ["address", "amount"],
  allocations.map((a) => ({ address: a.address, amount: formatEther(a.amount) }))
);
fs.writeFileSync(
  path.join(dir, "claims.json"),
  JSON.stringify(
    { round: Number(round), root, total: total.toString(), listedTotal: listed.toString(), claims },
    null,
    2
  ) + "\n"
);

console.log(
  `Round ${round}: ${allocations.length} wallets, ${formatEther(listed)} KUJI listed, ${formatEther(total)} reserved`
);
console.log(`Merkle root: ${root}`);
