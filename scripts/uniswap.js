// Uniswap v3 helpers shared by the launch, the airdrop gate and the fork checks.
// All prices are Uniswap's raw token1/token0 ratio (KUJI and WETH both have 18 decimals).

const Q96 = 2n ** 96n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const TICK_SPACING = 200; // 1% fee tier

const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)",
  "function ownerOf(uint256) view returns (address)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
];

// Uniswap's TickMath.getSqrtRatioAtTick, exactly.
function sqrtRatioAtTick(tick) {
  const abs = BigInt(Math.abs(tick));
  if (abs > BigInt(MAX_TICK)) throw new Error(`tick ${tick} out of range`);
  let ratio = abs & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const steps = [
    0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
    0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
    0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
    0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
    0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n,
    0x48a170391f7dc42444e8fa2n,
  ];
  for (let i = 0; i < steps.length; i++) if (abs & (2n << BigInt(i))) ratio = (ratio * steps[i]) >> 128n;
  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/**
 * The one-sided launch: a pool that starts at `marketCapUsd` with all the KUJI in a range
 * from the starting price upward, so it holds no ETH until someone buys.
 */
function launchPlan({ kuji, weth, supply, marketCapUsd, ethUsd }) {
  const kujiIs0 = kuji.toLowerCase() < weth.toLowerCase();
  const ethPerKuji = marketCapUsd / ethUsd / Number(supply / 10n ** 18n);
  const raw = kujiIs0 ? ethPerKuji : 1 / ethPerKuji; // token1 per token0
  const exact = Math.log(raw) / Math.log(1.0001);
  const tick = Math.round(exact / TICK_SPACING) * TICK_SPACING;
  // Buying KUJI moves the price up when KUJI is token0 and down when it is token1, so the
  // range runs from the starting tick toward the far end in that direction.
  const far = Math.floor(MAX_TICK / TICK_SPACING) * TICK_SPACING;
  const [tickLower, tickUpper] = kujiIs0 ? [tick, far] : [-far, tick];
  const actualEthPerKuji = kujiIs0 ? 1.0001 ** tick : 1 / 1.0001 ** tick;
  return {
    kujiIs0,
    token0: kujiIs0 ? kuji : weth,
    token1: kujiIs0 ? weth : kuji,
    tick,
    tickLower,
    tickUpper,
    sqrtPriceX96: sqrtRatioAtTick(tick),
    startMarketCapUsd: actualEthPerKuji * ethUsd * Number(supply / 10n ** 18n),
  };
}

/** KUJI still in the launch position at the pool's current price. */
function kujiInPosition({ kujiIs0, tickLower, tickUpper, liquidity }, sqrtP) {
  const a = sqrtRatioAtTick(tickLower), b = sqrtRatioAtTick(tickUpper);
  const L = BigInt(liquidity);
  if (kujiIs0) {
    const p = sqrtP < a ? a : sqrtP;
    if (p >= b) return 0n;
    return (L * Q96 * (b - p)) / b / p;
  }
  const p = sqrtP > b ? b : sqrtP;
  if (p <= a) return 0n;
  return (L * (p - a)) / Q96;
}

/** KUJI that buyers have taken out of the launch position so far. */
async function kujiBought(ethers, launch) {
  const pool = new ethers.Contract(launch.pool, POOL_ABI, ethers.provider);
  const [sqrtP] = await pool.slot0();
  const left = kujiInPosition(launch, sqrtP);
  const initial = BigInt(launch.kujiAdded);
  return { bought: initial > left ? initial - left : 0n, sqrtP };
}

/**
 * Market cap (in ETH) once buyers have taken `bought` KUJI, using the launch curve. A buy
 * of x KUJI from a range that starts at sqrt price s0 moves it to s with
 * x = L (1/s0 - 1/s) when KUJI is token0, or x = L (s0 - s) when it is token1.
 */
function marketCapEthAt(launch, bought, supply) {
  const L = Number(launch.liquidity);
  const s0 = Number(sqrtRatioAtTick(launch.kujiIs0 ? launch.tickLower : launch.tickUpper)) / 2 ** 96;
  const x = Number(bought);
  let ethPerKuji;
  if (launch.kujiIs0) {
    const s = 1 / (1 / s0 - x / L);
    ethPerKuji = s * s;
  } else {
    const s = s0 - x / L;
    ethPerKuji = 1 / (s * s);
  }
  return ethPerKuji * Number(supply / 10n ** 18n);
}

/** ETH price in USD: ETH_USD if set, else Kraken's public ticker, else Coinbase's. */
async function ethPriceUsd() {
  if (process.env.ETH_USD) return Number(process.env.ETH_USD);
  const sources = [
    ["Kraken", "https://api.kraken.com/0/public/Ticker?pair=ETHUSD", (j) => Object.values(j.result || {})[0]?.c?.[0]],
    ["Coinbase", "https://api.coinbase.com/v2/prices/ETH-USD/spot", (j) => j.data?.amount],
  ];
  for (const [name, url, read] of sources) {
    try {
      const price = Number(read(await (await fetch(url)).json()));
      if (price > 0) return price;
    } catch (e) {
      console.warn(`${name} price unavailable: ${e.message}`);
    }
  }
  throw new Error("couldn't read the ETH price from Kraken or Coinbase; set ETH_USD");
}

module.exports = { Q96, MIN_TICK, MAX_TICK, TICK_SPACING, NPM_ABI, FACTORY_ABI, POOL_ABI, sqrtRatioAtTick, launchPlan, kujiInPosition, kujiBought, marketCapEthAt, ethPriceUsd };
