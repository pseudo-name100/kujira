const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const cfg = require("./tokenomics");

const DAY = 24 * 60 * 60;

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const teamAddress = process.env.TEAM_ADDRESS;

  const pct = Object.values(cfg.allocations).reduce((a, b) => a + b, 0);
  if (pct !== 100) throw new Error(`allocations add up to ${pct}%, expected 100%`);
  if (cfg.allocations.team > 0 && !teamAddress) {
    throw new Error("TEAM_ADDRESS is not set (or set allocations.team to 0)");
  }
  if (teamAddress && !ethers.isAddress(teamAddress)) {
    throw new Error(`TEAM_ADDRESS ${teamAddress} is not a valid address (check for typos / checksum)`);
  }

  console.log(`Network:  ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const token = await ethers.deployContract("KujiraToken", [deployer.address]);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`KujiraToken: ${tokenAddress}`);

  const pod = await ethers.deployContract("KujiraPod", [tokenAddress, deployer.address]);
  await pod.waitForDeployment();
  const podAddress = await pod.getAddress();
  console.log(`KujiraPod:   ${podAddress}`);

  const supply = await token.TOTAL_SUPPLY();
  const share = (p) => (supply * BigInt(p)) / 100n;

  const rewards = share(cfg.allocations.stakingRewards);
  if (rewards > 0n) {
    await (await token.approve(podAddress, rewards)).wait();
    await (await pod.fundRewards(rewards, cfg.rewardDurationDays * DAY)).wait();
    console.log(`Funded ${ethers.formatEther(rewards)} KUJI over ${cfg.rewardDurationDays} days`);
  }

  const drop = await ethers.deployContract("KujiraDrop", [podAddress, deployer.address]);
  await drop.waitForDeployment();
  const dropAddress = await drop.getAddress();
  const airdrop = share(cfg.allocations.airdrop);
  if (airdrop > 0n) await (await token.transfer(dropAddress, airdrop)).wait();
  console.log(`KujiraDrop:  ${dropAddress} (${ethers.formatEther(airdrop)} KUJI pool)`);

  let vestingAddress = null;
  const team = share(cfg.allocations.team);
  if (team > 0n) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const start = now + cfg.teamCliffDays * DAY;
    // OpenZeppelin VestingWallet: releases linearly from `start` over `duration`.
    const vesting = await ethers.deployContract("VestingWallet", [
      teamAddress,
      start,
      cfg.teamVestingDays * DAY,
    ]);
    await vesting.waitForDeployment();
    vestingAddress = await vesting.getAddress();
    await (await token.transfer(vestingAddress, team)).wait();
    console.log(`VestingWallet: ${vestingAddress} (${ethers.formatEther(team)} KUJI for ${teamAddress})`);
  }

  const out = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    KujiraToken: tokenAddress,
    KujiraPod: podAddress,
    KujiraDrop: dropAddress,
    VestingWallet: vestingAddress,
    teamAddress: teamAddress || null,
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const suffix = network.name === "hardhat" || network.name === "localhost" ? ".local" : "";
  fs.writeFileSync(path.join(dir, `${network.name}${suffix}.json`), JSON.stringify(out, null, 2) + "\n");

  const left = await token.balanceOf(deployer.address);
  console.log(`Deployer still holds ${ethers.formatEther(left)} KUJI (liquidity)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
