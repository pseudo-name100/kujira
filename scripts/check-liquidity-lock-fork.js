// Usage: npx hardhat --config <a config whose hardhat network forks Ink mainnet> run scripts/check-liquidity-lock-fork.js
// End-to-end check of KujiraLiquidityLock against the real Uniswap v3 on Ink, on a local
// fork: create the 1% KUJI/WETH pool, add full-range liquidity, lock the position, swap
// through Uniswap's router, collect the fees, and confirm the liquidity can't be removed.
const hre = require("hardhat");
const { uniswapV3 } = require("./tokenomics");

const ink = uniswapV3.ink;
const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256,uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function safeTransferFrom(address,address,uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];
const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

function sqrtPriceX96(amount0, amount1) {
  // sqrt(amount1 / amount0) * 2^96, in integers
  const ratio = (amount1 << 192n) / amount0;
  let x = ratio, y = (x + 1n) / 2n;
  while (y < x) [x, y] = [y, (y + ratio / y) / 2n];
  return x;
}

async function main() {
  const { ethers } = hre;
  const [lp, feeWallet, trader] = await ethers.getSigners();
  const fmt = ethers.formatEther;

  const kuji = await ethers.deployContract("KujiraToken", [lp.address, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress]);
  const lock = await ethers.deployContract("KujiraLiquidityLock", [ink.positionManager, await kuji.getAddress(), feeWallet.address]);
  const npm = new ethers.Contract(ink.positionManager, NPM_ABI, lp);
  const weth = new ethers.Contract(ink.weth, WETH_ABI, lp);
  const router = new ethers.Contract(ink.router, ROUTER_ABI, trader);

  const kujiAmt = ethers.parseEther("550000000");
  const ethAmt = ethers.parseEther("1");
  await (await weth.deposit({ value: ethAmt })).wait();
  const k = await kuji.getAddress();
  const kujiIs0 = k.toLowerCase() < ink.weth.toLowerCase();
  const [token0, token1] = kujiIs0 ? [k, ink.weth] : [ink.weth, k];
  const [amt0, amt1] = kujiIs0 ? [kujiAmt, ethAmt] : [ethAmt, kujiAmt];

  await (await npm.createAndInitializePoolIfNecessary(token0, token1, 10000, sqrtPriceX96(amt0, amt1))).wait();
  await (await kuji.approve(ink.positionManager, ethers.MaxUint256)).wait();
  await (await weth.approve(ink.positionManager, ethers.MaxUint256)).wait();
  const tx = await npm.mint({
    token0, token1, fee: 10000, tickLower: -887200, tickUpper: 887200,
    amount0Desired: amt0, amount1Desired: amt1, amount0Min: 0, amount1Min: 0,
    recipient: lp.address, deadline: Math.floor(Date.now() / 1000) + 3600,
  });
  const rc = await tx.wait();
  const tokenId = rc.logs.map((l) => { try { return npm.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "Transfer").args.tokenId;
  console.log(`Pool created at 1%, position #${tokenId}`);

  await (await npm.safeTransferFrom(lp.address, await lock.getAddress(), tokenId)).wait();
  console.log(`Position owner is now the lock: ${(await npm.ownerOf(tokenId)) === (await lock.getAddress())}`);

  // Trade both ways so fees build up in both tokens
  const tw = new ethers.Contract(ink.weth, WETH_ABI, trader);
  await (await tw.deposit({ value: ethers.parseEther("0.2") })).wait();
  await (await tw.approve(ink.router, ethers.MaxUint256)).wait();
  await (await router.exactInputSingle({ tokenIn: ink.weth, tokenOut: k, fee: 10000, recipient: trader.address, amountIn: ethers.parseEther("0.2"), amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
  const got = await kuji.balanceOf(trader.address);
  await (await kuji.connect(trader).approve(ink.router, ethers.MaxUint256)).wait();
  await (await router.exactInputSingle({ tokenIn: k, tokenOut: ink.weth, fee: 10000, recipient: trader.address, amountIn: got / 2n, amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
  console.log(`Trader bought ${fmt(got)} KUJI for 0.2 ETH, then sold half back`);

  const k0 = await kuji.balanceOf(feeWallet.address);
  const w0 = await weth.balanceOf(feeWallet.address);
  await (await lock.connect(trader).collect(tokenId)).wait(); // anyone can trigger it
  console.log(`Fees to fee wallet: ${fmt((await weth.balanceOf(feeWallet.address)) - w0)} WETH (1% of 0.2 = 0.002), ${fmt((await kuji.balanceOf(feeWallet.address)) - k0)} KUJI`);

  let blocked = false;
  try {
    await npm.decreaseLiquidity.staticCall({ tokenId, liquidity: 1, amount0Min: 0, amount1Min: 0, deadline: Math.floor(Date.now() / 1000) + 3600 });
  } catch {
    blocked = true;
  }
  console.log(`Former owner can remove liquidity: ${!blocked}`);
  if (!blocked) throw new Error("liquidity was removable");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
