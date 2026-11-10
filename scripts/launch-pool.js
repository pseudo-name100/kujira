// Usage: MARKET_CAP_USD=40000 [ETH_USD=3500] npx hardhat run scripts/launch-pool.js --network ink
// Opens trading, one-sided: creates the 1% KUJI/WETH Uniswap v3 pool at the starting market
// cap and adds the deployer's KUJI in a range from that price upward. No ETH goes in; buyers
// bring it. The position is minted straight to KujiraLiquidityLock, so it is locked from the
// moment it exists. Without ETH_USD the ETH price is read from Kraken.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { uniswapV3 } = require("./tokenomics");
const { NPM_ABI, FACTORY_ABI, POOL_ABI, launchPlan, ethPriceUsd } = require("./uniswap");
const { read, send } = require("./rpc");

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

  const marketCapUsd = Number(process.env.MARKET_CAP_USD || 40000);
  if (!(marketCapUsd > 0)) throw new Error("MARKET_CAP_USD must be a positive number");
  const ethUsd = await ethPriceUsd();

  const kuji = await ethers.getContractAt("KujiraToken", d.KujiraToken);
  const [supply, amount, taxPool, launchedAt] = await read(() =>
    Promise.all([kuji.TOTAL_SUPPLY(), kuji.balanceOf(deployer.address), kuji.pool(), kuji.launchedAt()])
  );
  // The tax clock starts with the first KUJI into the pool's address. If anything got there
  // before this run, the 30 minutes would already be running: stop rather than launch late.
  if (taxPool !== ethers.ZeroAddress && launchedAt !== 0n) {
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
  let poolAddress = await read(() => factory.getPool(plan.token0, plan.token1, uni.fee));
  if (poolAddress !== ethers.ZeroAddress) {
    const [sqrtP] = await read(() => new ethers.Contract(poolAddress, POOL_ABI, deployer).slot0());
    if (sqrtP !== 0n && sqrtP !== plan.sqrtPriceX96) {
      throw new Error(`a KUJI/WETH 1% pool already exists at ${poolAddress} at a different price; nothing was added`);
    }
  }
  await send("create the pool", () => npm.createAndInitializePoolIfNecessary(plan.token0, plan.token1, uni.fee, plan.sqrtPriceX96));
  // Read until the RPC has caught up with the new pool.
  poolAddress = await read(async () => {
    const a = await factory.getPool(plan.token0, plan.token1, uni.fee);
    if (a === ethers.ZeroAddress) throw new Error("pool not visible yet");
    return a;
  });
  const [, tickNow] = await read(async () => {
    const s0 = await new ethers.Contract(poolAddress, POOL_ABI, deployer).slot0();
    if (s0[0] === 0n) throw new Error("pool not initialized yet");
    return s0;
  });
  if (Number(tickNow) !== plan.tick) throw new Error(`pool tick ${tickNow}, expected ${plan.tick}`);
  console.log(`Pool:       ${poolAddress}`);

  await send("approve the position manager", () => kuji.approve(uni.positionManager, amount));
  const deadline = (await read(() => ethers.provider.getBlock("latest"))).timestamp + 1800; // chain time, not this machine's
  const { tx, receipt: rc } = await send("add the liquidity", () => npm.mint({
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
    deadline,
  }));
  const ev = rc.logs.map((l) => { try { return npm.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "IncreaseLiquidity");
  const positionId = ev.args.tokenId;
  const kujiAdded = plan.kujiIs0 ? ev.args.amount0 : ev.args.amount1;
  // Save straight away: the liquidity is in and locked now, whatever happens next.
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

  if ((plan.kujiIs0 ? ev.args.amount1 : ev.args.amount0) !== 0n) throw new Error("position took ETH; expected KUJI only");
  const owner = await read(() => npm.ownerOf(positionId));
  if (owner !== d.KujiraLiquidityLock) throw new Error("position isn't owned by the lock");

  // mint() skips onERC721Received, so list the position for collectAll.
  const lock = await ethers.getContractAt("KujiraLiquidityLock", d.KujiraLiquidityLock);
  await send("list the position in the lock", () => lock.track(positionId));
  console.log(`Position:   #${positionId}, ${ethers.formatEther(kujiAdded)} KUJI, owned by the lock (tx ${tx.hash})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
