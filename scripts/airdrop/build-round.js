// Usage: node scripts/airdrop/build-round.js <round>
// Reads airdrop/round-<n>/traders.csv, splits the round total (times `oversubscribe`), and writes:
//   allocations.csv  human-readable list to review and publish
//   claims.json      Merkle root, reserved total, and each wallet's amount + proof (for the claim page)
const fs = require("fs");
const path = require("path");
const { formatEther } = require("ethers");
const { rounds } = require("./config");
const { roundDir, allocate, buildTree, readCsv, writeCsv } = require("./lib");

const round = process.argv[2];
const cfg = rounds[round];
if (!cfg) throw new Error(`no config for round ${round} in scripts/airdrop/config.js`);

const dir = roundDir(round);
const traders = readCsv(path.join(dir, "traders.csv")).map((t) => ({
  address: t.address,
  activeDays: Number(t.activeDays),
}));
const oversubscribe = BigInt(cfg.oversubscribe ?? 1);
const allocations = allocate(traders, cfg.total * oversubscribe, cfg.maxWeightDays);
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
