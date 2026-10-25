// Usage: node scripts/airdrop/build-round.js <round>
// Reads airdrop/round-<n>/traders.csv, splits the round total (times `oversubscribe`), and writes:
//   allocations.csv  human-readable list to review and publish
//   claims.json      Merkle root, reserved total, and each wallet's amount + proof (for the claim page)
const fs = require("fs");
const path = require("path");
const { formatEther } = require("ethers");
const { rounds } = require("./config");
const { roundDir, filterTraders, allocate, buildTree, readCsv, writeCsv } = require("./lib");

const round = process.argv[2];
const cfg = rounds[round];
if (!cfg) throw new Error(`no config for round ${round} in scripts/airdrop/config.js`);

const dir = roundDir(round);
// Re-apply the filters so config changes take effect without collecting again.
const traders = filterTraders(
  readCsv(path.join(dir, "traders.csv")).map((t) => ({
    address: t.address,
    swaps: Number(t.swaps),
    activeDays: Number(t.activeDays),
  })),
  cfg.eligibility
);
const listedTarget = (cfg.total * BigInt(Math.round((cfg.oversubscribe ?? 1) * 100))) / 100n;
const allocations = cfg.amountEach
  ? traders.map((t) => ({ address: t.address, amount: cfg.amountEach }))
  : allocate(traders, listedTarget, cfg.maxWeightDays);
const { root, total: listed, claims } = buildTree(allocations);
// The contract reserves this much; it can't be more than the list adds up to.
const total = listed < cfg.total ? listed : cfg.total;

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
