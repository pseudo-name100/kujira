// Usage: PRIVY_APP_SECRET=... node scripts/airdrop/tide.js [YYYY-MM]
// Builds one month of the Tide (config `tide`): everyone who signed up on kujira.ink with X
// by the month's end, one share per X account, whose wallet + Pod held at least `minHeld` at
// every hidden snapshot that month gets an equal share of `monthly`. With no month given it
// builds the month that just ended. Writes airdrop/tide-<YYYY-MM>/claims.json and
// allocations.csv; scripts/airdrop/start-round.js with TIDE=<YYYY-MM> starts it on-chain.
//
// The snapshots come from the hash of the month's last block, so nobody can know them in
// advance and anyone can recompute them afterwards.
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, formatEther } = require("ethers");
const { tide } = require("./config");
const { snapshotBlocks, signupsFromPrivyUsers, tideShares, buildTree, writeCsv } = require("./lib");
const { readAt, blockAtTime } = require("./collect-holding-snapshots");
const { privyUsers } = require("./collect-signups");

const RPC = process.env.INK_RPC_URL || "https://rpc-gel.inkonchain.com";

function monthOf(arg) {
  if (arg) {
    if (!/^\d{4}-\d{2}$/.test(arg)) throw new Error("month must look like 2026-12");
    return arg;
  }
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return prev.toISOString().slice(0, 7);
}

const monthIndex = (m) => {
  const [y, mo] = m.split("-").map(Number);
  const [fy, fm] = tide.firstMonth.split("-").map(Number);
  return (y - fy) * 12 + (mo - fm);
};

async function main() {
  const month = monthOf(process.argv[2]);
  const i = monthIndex(month);
  if (i < 0 || i >= tide.months) {
    console.log(`${month} is outside the Tide (${tide.firstMonth}, ${tide.months} months); nothing to build.`);
    return;
  }
  const root = path.join(__dirname, "..", "..");
  const dir = path.join(root, "airdrop", `tide-${month}`);
  if (fs.existsSync(path.join(dir, "claims.json"))) throw new Error(`the Tide for ${month} is already built`);

  const [y, mo] = month.split("-").map(Number);
  const from = Date.UTC(y, mo - 1, 1) / 1000, to = Date.UTC(y, mo, 1) / 1000;
  const provider = new JsonRpcProvider(RPC, 57073, { staticNetwork: true });
  const fromBlock = await blockAtTime(provider, from);
  const endBlock = await blockAtTime(provider, to);
  const seed = (await provider.getBlock(endBlock)).hash;
  const blocks = snapshotBlocks(seed, fromBlock, endBlock, tide.snapshots);
  console.log(`Tide ${month}: blocks ${fromBlock}-${endBlock}, seed ${seed}; snapshots ${blocks.join(", ")}`);

  const d = JSON.parse(fs.readFileSync(path.join(root, "deployments", "ink.json"), "utf8"));
  const appId = process.env.PRIVY_APP_ID || JSON.parse(fs.readFileSync(path.join(root, "site", "config.json"), "utf8")).privyAppId;
  if (!process.env.PRIVY_APP_SECRET) throw new Error("set PRIVY_APP_SECRET");
  const people = signupsFromPrivyUsers(await privyUsers(appId, process.env.PRIVY_APP_SECRET), {
    until: to,
    exclude: [d.deployer, d.feeRecipient, d.liquidity],
  });
  const snaps = [];
  for (const b of blocks) snaps.push(await readAt(provider, b, people.map((p) => p.address), d));
  const shares = tideShares(people, snaps, { minHeld: tide.minHeld, budget: tide.monthly });
  console.log(`${people.length} people signed up with X; ${shares.length} held ${formatEther(tide.minHeld)}+ all month`);
  if (shares.length === 0) {
    console.log("Nobody qualified; no list this month (its KUJI stays in the Drop).");
    return;
  }

  const { root: merkleRoot, total, claims } = buildTree(shares);
  const label = `The Tide · ${new Date(from * 1000).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}`;
  fs.mkdirSync(dir, { recursive: true });
  writeCsv(path.join(dir, "allocations.csv"), ["address", "amount"], shares.map((s) => ({ address: s.address, amount: formatEther(s.amount) })));
  fs.writeFileSync(
    path.join(dir, "claims.json"),
    JSON.stringify(
      { round: `tide-${month}`, label, root: merkleRoot, total: total.toString(), listedTotal: total.toString(), tide: { month, seed, blocks }, claims },
      null,
      2
    ) + "\n"
  );
  console.log(`${label}: ${shares.length} people, ${formatEther(shares[0].amount)} KUJI each. Merkle root ${merkleRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
