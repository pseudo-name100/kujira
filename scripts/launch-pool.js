// Usage: MARKET_CAP_USD=10000 [ETH_USD=3500] npx hardhat run scripts/launch-pool.js --network ink
// Opens trading, one-sided: creates the 1% KUJI/WETH Uniswap v3 pool at the starting market
// cap and adds the deployer's KUJI in a range from that price upward. No ETH goes in; buyers
// bring it. The position is minted straight to KujiraLiquidityLock, so it is locked from the
// moment it exists. Without ETH_USD the ETH price is read from Kraken.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { uniswapV3 } = require("./tokenomics");
const { NPM_ABI, FACTORY_ABI, POOL_ABI, launchPlan, ethPriceUsd } = require("./uniswap");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const local = network.name === "hardhat" || network.name === "localhost";
  const uni = uniswapV3[network.name] ?? (local ? uniswapV3.ink : null);
  if (!uni) throw new Error(`no Uniswap v3 addresses for ${network.name} in scripts/tokenomics.js`);

  const file = path.join(__dirname, "..", "deployments", `${network.name}${local ? ".local" : ""}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (d.launch) throw new Error(`already launched: pool ${d.launch.pool}, position #${d.launch.positionId}`);
  if (!d.KujiraLiquidityLock) throw new Error("no KujiraLiquidityLock in the deployment");

  const marketCapUsd = Number(process.env.MARKET_CAP_USD || 10000);
  if (!(marketCapUsd > 0)) throw new Error("MARKET_CAP_USD must be a positive number");
  const ethUsd = await ethPriceUsd();

  const kuji = await ethers.getContractAt("KujiraToken", d.KujiraToken);
  const supply = await kuji.TOTAL_SUPPLY();
  const amount = await kuji.balanceOf(deployer.address);
  // The tax clock starts with the first KUJI into the pool's address. If anything got there
  // before this run, the 30 minutes would already be running: stop rather than launch late.
  if ((await kuji.pool()) !== ethers.ZeroAddress && (await kuji.launchedAt()) !== 0n) {
    throw new Error("the launch tax clock has already started (KUJI reached the pool address before launch); nothing was added");
  }
  if (amount === 0n) throw new Error(`${deployer.address} holds no KUJI to add`);

  const plan = launchPlan({ kuji: d.KujiraToken, weth: uni.weth, supply, marketCapUsd, ethUsd });
  console.log(`ETH price:  $${ethUsd}`);
  console.log(`Start:      $${plan.startMarketCapUsd.toFixed(0)} market cap (asked for $${marketCapUsd}; Uniswap prices move in 2% steps on this tier)`);
  console.log(`Adding:     ${ethers.formatEther(amount)} KUJI, no ETH`);

  const npm = new ethers.Contract(uni.positionManager, NPM_ABI, deployer);
  const factory = new ethers.Contract(uni.factory, FACTORY_ABI, deployer);

  // Someone else could have created the pool first at another price. With no liquidity in
  // it, our position would start at their price, so stop instead.
  let poolAddress = await factory.getPool(plan.token0, plan.token1, uni.fee);
  if (poolAddress !== ethers.ZeroAddress) {
    const [sqrtP] = await new ethers.Contract(poolAddress, POOL_ABI, deployer).slot0();
    if (sqrtP !== 0n && sqrtP !== plan.sqrtPriceX96) {
      throw new Error(`a KUJI/WETH 1% pool already exists at ${poolAddress} at a different price; nothing was added`);
    }
  }
  await (await npm.createAndInitializePoolIfNecessary(plan.token0, plan.token1, uni.fee, plan.sqrtPriceX96)).wait();
  poolAddress = await factory.getPool(plan.token0, plan.token1, uni.fee);
  const [, tickNow] = await new ethers.Contract(poolAddress, POOL_ABI, deployer).slot0();
  if (Number(tickNow) !== plan.tick) throw new Error(`pool tick ${tickNow}, expected ${plan.tick}`);
  console.log(`Pool:       ${poolAddress}`);

  await (await kuji.approve(uni.positionManager, amount)).wait();
  const tx = await npm.mint({
    token0: plan.token0,
    token1: plan.token1,
    fee: uni.fee,
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    amount0Desired: plan.kujiIs0 ? amount : 0n,
    amount1Desired: plan.kujiIs0 ? 0n : amount,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: d.KujiraLiquidityLock,
    deadline: Math.floor(Date.now() / 1000) + 1800,
  });
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return npm.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "IncreaseLiquidity");
  const positionId = ev.args.tokenId;
  const kujiAdded = plan.kujiIs0 ? ev.args.amount0 : ev.args.amount1;
  if ((plan.kujiIs0 ? ev.args.amount1 : ev.args.amount0) !== 0n) throw new Error("position took ETH; expected KUJI only");
  if ((await npm.ownerOf(positionId)) !== d.KujiraLiquidityLock) throw new Error("position isn't owned by the lock");

  // mint() skips onERC721Received, so list the position for collectAll.
  const lock = await ethers.getContractAt("KujiraLiquidityLock", d.KujiraLiquidityLock);
  await (await lock.track(positionId)).wait();
  console.log(`Position:   #${positionId}, ${ethers.formatEther(kujiAdded)} KUJI, owned by the lock (tx ${tx.hash})`);

  d.launch = {
    pool: poolAddress,
    positionId: positionId.toString(),
    kujiIs0: plan.kujiIs0,
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    liquidity: ev.args.liquidity.toString(),
    kujiAdded: kujiAdded.toString(),
    startMarketCapUsd: Math.round(plan.startMarketCapUsd),
    ethUsdAtLaunch: ethUsd,
    tx: tx.hash,
  };
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
