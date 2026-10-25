// Usage: ROUND=1 npx hardhat run scripts/airdrop/close-round.js --network ink
// After the claim deadline, returns the round's unclaimed tokens to the pool.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { roundDir } = require("./lib");

async function main() {
  const { ethers, network } = hre;
  const round = process.env.ROUND;
  const claimsFile = path.join(roundDir(round), "claims.json");
  const claims = JSON.parse(fs.readFileSync(claimsFile, "utf8"));
  const started = claims.started?.[network.name];
  if (!started) throw new Error(`round ${round} was not started on ${network.name}`);

  const suffix = network.name === "hardhat" || network.name === "localhost" ? ".local" : "";
  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "deployments", `${network.name}${suffix}.json`), "utf8")
  );
  const drop = await ethers.getContractAt("KujiraDrop", deployment.KujiraDrop);
  const r = await drop.rounds(started.roundId);
  const before = r.reserved - r.paid;
  const tx = await drop.closeRound(started.roundId);
  await tx.wait();

  started.closed = true;
  fs.writeFileSync(claimsFile, JSON.stringify(claims, null, 2) + "\n");
  console.log(`Closed round ${round}; ${ethers.formatEther(before)} KUJI back in the pool (tx ${tx.hash})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
