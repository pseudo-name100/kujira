// Usage: ROUND=1 npx hardhat run scripts/airdrop/start-round.js --network ink
// Publishes the Merkle root from airdrop/round-<n>/claims.json to KujiraDrop.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { rounds } = require("./config");
const { roundDir } = require("./lib");
const { checkDropCap } = require("./gate");

async function main() {
  const { ethers, network } = hre;
  const round = process.env.ROUND;
  const cfg = rounds[round];
  if (!cfg) throw new Error("set ROUND to a round configured in scripts/airdrop/config.js");

  const suffix = network.name === "hardhat" || network.name === "localhost" ? ".local" : "";
  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "deployments", `${network.name}${suffix}.json`), "utf8")
  );
  const claimsFile = path.join(roundDir(round), "claims.json");
  const claims = JSON.parse(fs.readFileSync(claimsFile, "utf8"));

  claims.started ||= {};
  if (claims.started[network.name]) {
    throw new Error(`round ${round} already started on ${network.name} as id ${claims.started[network.name].roundId}`);
  }

  const drop = await ethers.getContractAt("KujiraDrop", deployment.KujiraDrop);
  const total = BigInt(claims.total);
  const reserve = total + (total * BigInt(cfg.stakeBonusBps)) / 10_000n;
  // Local test chains without a pool skip the cap; every real network must pass it.
  if (deployment.launch || !suffix) await checkDropCap(ethers, deployment, drop, reserve);
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const deadline = now + cfg.claimDays * 24 * 60 * 60;

  const id = await drop.roundCount();
  const tx = await drop.startRound(claims.root, claims.total, deadline, cfg.stakeBonusBps);
  await tx.wait();

  claims.started[network.name] = {
    roundId: Number(id),
    deadline,
    stakeBonusBps: cfg.stakeBonusBps,
    drop: deployment.KujiraDrop,
    tx: tx.hash,
  };
  fs.writeFileSync(claimsFile, JSON.stringify(claims, null, 2) + "\n");

  console.log(`Started round ${round} as on-chain id ${id} (tx ${tx.hash})`);
  console.log(`Claims close ${new Date(deadline * 1000).toISOString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
