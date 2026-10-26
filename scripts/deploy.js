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
    // Never echo the value: if someone pasted a private key here, it must not reach the logs.
    const hint = /^(0x)?[0-9a-fA-F]{64}$/.test(value.trim())
      ? "it looks like a private key, not an address. Replace it with the wallet's public address (0x followed by 40 characters), and move that wallet's funds to a new wallet"
      : "check for typos; it should be 0x followed by 40 characters";
    throw new Error(`${name} is not a valid address: ${hint}`);
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
  // Where the liquidity share goes. Defaults to the deployer.
  const liquidityAddress = requireAddress(ethers, "LIQUIDITY_ADDRESS", false) || deployer.address;
  // Uniswap v3 on this network, if configured: deploy the liquidity lock, whose fees go to
  // FEE_RECIPIENT.
  const uni = cfg.uniswapV3?.[network.name];
  const feeRecipient = requireAddress(ethers, "FEE_RECIPIENT", Boolean(uni) && !local);

  const dir = path.join(__dirname, "..", "deployments");
  const outFile = path.join(dir, `${network.name}${local ? ".local" : ""}.json`);
  if (!local && fs.existsSync(outFile)) {
    throw new Error(`${path.relative(process.cwd(), outFile)} exists: KUJI is already deployed on ${network.name}`);
  }

  console.log(`Network:  ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  // The launch tax needs the Uniswap pool, so only networks with Uniswap get one.
  const taxUni = uni || (local ? cfg.uniswapV3.ink : null);
  const tokenArgs = taxUni
    ? [deployer.address, taxUni.factory, taxUni.weth, feeRecipient || deployer.address]
    : [deployer.address, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress];
  const token = await ethers.deployContract("KujiraToken", tokenArgs);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`KujiraToken: ${tokenAddress}`);
  if (taxUni) console.log(`Launch tax:  25% falling to 0 over 30 minutes on buys from ${await token.pool()}, to ${tokenArgs[3]}`);

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

  let lockAddress = null;
  if (uni || local) {
    const { positionManager, weth } = uni ?? cfg.uniswapV3.ink;
    const lock = await ethers.deployContract("KujiraLiquidityLock", [
      positionManager,
      tokenAddress,
      weth,
      feeRecipient || deployer.address,
    ]);
    await lock.waitForDeployment();
    lockAddress = await lock.getAddress();
    console.log(`KujiraLiquidityLock: ${lockAddress} (fees to ${feeRecipient || deployer.address})`);
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
    tokenArgs,
    KujiraPod: podAddress,
    KujiraDrop: dropAddress,
    KujiraLiquidityLock: lockAddress,
    feeRecipient: lockAddress ? feeRecipient || deployer.address : null,
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
