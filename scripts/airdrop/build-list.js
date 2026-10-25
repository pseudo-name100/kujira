// Usage: node scripts/airdrop/build-list.js <round>
// Builds a round's list from scratch, whichever kind of round it is:
//   DEX-trader rounds:  discover routers -> collect traders -> build
//   whale rounds:       snapshot KUJI holders -> build
const { execFileSync } = require("child_process");
const path = require("path");
const { rounds } = require("./config");

const round = process.argv[2];
const cfg = rounds[round];
if (!cfg) throw new Error(`no config for round ${round} in scripts/airdrop/config.js`);

const steps =
  cfg.source === "kuji-holders"
    ? ["collect-kuji-holders.js", "build-round.js"]
    : ["discover-routers.js", "collect-dex-traders.js", "build-round.js"];
for (const step of steps) {
  console.log(`\n== ${step}`);
  execFileSync(process.execPath, [path.join(__dirname, step), round], { stdio: "inherit" });
}
