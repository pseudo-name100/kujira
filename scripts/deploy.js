const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const cfg = require("./tokenomics");

const DAY = 24 * 60 * 60;

function requireAddress(ethers, name, needed) {
  const value = process.env[name];
  if (!value) {
    if (needed) throw new Error(`${name} is not set`);
    return null;
  }
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} ${value} is not a valid address (check for typos / checksum)`);
  }
  return ethers.getAddress(value);
}

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const local = network.name === "hardhat" || network.name === "localhost";

  const pct = Object.values(cfg.allocations).reduce((a, b) => a + b, 0);
  if (pct !== 100) throw new Error(`allocations add up to ${pct}%, expected 100%`);
  const teamAddress = requireAddress(ethers, "TEAM_ADDRESS", cfg.allocations.team > 0);
  // Where the liquidity share goes. Defaults to the deployer.
  const liquidityAddress = requireAddress(ethers, "LIQUIDITY_ADDRESS", false) || deployer.address;

  const dir = path.join(__dirname, "..", "deployments");
  const outFile = path.join(dir, `${network.name}${local ? ".local" : ""}.json`);
  if (!local && fs.existsSync(outFile)) {
    throw new Error(`${path.relative(process.cwd(), outFile)} exists: KUJI is already deployed on ${network.name}`);
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

  let vesting = null;
  const team = share(cfg.allocations.team);
  if (team > 0n) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const start = now + cfg.teamCliffDays * DAY;
    const duration = cfg.teamVestingDays * DAY;
    // OpenZeppelin VestingWallet: releases linearly from `start` over `duration`.
    const wallet = await ethers.deployContract("VestingWallet", [teamAddress, start, duration]);
    await wallet.waitForDeployment();
    vesting = { address: await wallet.getAddress(), beneficiary: teamAddress, start, duration };
    await (await token.transfer(vesting.address, team)).wait();
    console.log(`VestingWallet: ${vesting.address} (${ethers.formatEther(team)} KUJI for ${teamAddress})`);
  }

  if (liquidityAddress !== deployer.address) {
    const rest = await token.balanceOf(deployer.address);
    await (await token.transfer(liquidityAddress, rest)).wait();
  }
  console.log(`Liquidity: ${ethers.formatEther(await token.balanceOf(liquidityAddress))} KUJI at ${liquidityAddress}`);

  const out = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    KujiraToken: tokenAddress,
    KujiraPod: podAddress,
    KujiraDrop: dropAddress,
    VestingWallet: vesting,
    liquidity: liquidityAddress,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
  console.log(`Saved ${path.relative(process.cwd(), outFile)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
