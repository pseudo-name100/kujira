// Usage: node scripts/airdrop/build-round.js <round>
// Reads airdrop/round-<n>/traders.csv, splits the round total, and writes:
//   allocations.csv  human-readable list to review and publish
//   claims.json      Merkle root, total, and each wallet's amount + proof (for the claim page)
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
const allocations = allocate(traders, cfg.total, cfg.maxWeightDays);
const { root, total, claims } = buildTree(allocations);

writeCsv(
  path.join(dir, "allocations.csv"),
  ["address", "amount"],
  allocations.map((a) => ({ address: a.address, amount: formatEther(a.amount) }))
);
fs.writeFileSync(
  path.join(dir, "claims.json"),
  JSON.stringify({ round: Number(round), root, total: total.toString(), claims }, null, 2) + "\n"
);

console.log(`Round ${round}: ${allocations.length} wallets, ${formatEther(total)} KUJI`);
console.log(`Merkle root: ${root}`);
