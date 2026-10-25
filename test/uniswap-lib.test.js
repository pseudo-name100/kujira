const { expect } = require("chai");
const { sqrtRatioAtTick, launchPlan, kujiInPosition, marketCapEthAt, MIN_TICK, MAX_TICK } = require("../scripts/uniswap");

const WETH = "0x4200000000000000000000000000000000000006";
const SUPPLY = 10n ** 27n;

describe("uniswap helpers", function () {
  it("matches Uniswap's TickMath at the edges and the middle", function () {
    expect(sqrtRatioAtTick(0)).to.equal(2n ** 96n);
    expect(sqrtRatioAtTick(MIN_TICK)).to.equal(4295128739n);
    expect(sqrtRatioAtTick(MAX_TICK)).to.equal(1461446703485210103287273052203988822378723970342n);
  });

  for (const [name, kuji] of [
    ["KUJI as token0", "0x0000000000000000000000000000000000000001"],
    ["KUJI as token1", "0xffffffffffffffffffffffffffffffffffffffff"],
  ]) {
    it(`starts near the asked market cap with all KUJI one-sided (${name})`, function () {
      const p = launchPlan({ kuji, weth: WETH, supply: SUPPLY, marketCapUsd: 10000, ethUsd: 3500 });
      expect(p.tick % 200).to.equal(0);
      expect(Math.abs(p.startMarketCapUsd - 10000)).to.be.below(100); // within 1%
      // The range starts exactly at the starting price, so the position holds KUJI only.
      const L = 10n ** 24n;
      const launch = { kujiIs0: p.kujiIs0, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: L };
      const full = kujiInPosition(launch, p.sqrtPriceX96);
      expect(full > 0n).to.equal(true);
      // Buying moves the price away from the start and takes KUJI out.
      const moved = sqrtRatioAtTick(p.kujiIs0 ? p.tick + 2000 : p.tick - 2000);
      expect(kujiInPosition(launch, moved) < full).to.equal(true);
      // The market cap curve starts at the launch price and rises as KUJI is bought.
      const start = marketCapEthAt(launch, 0n, SUPPLY) * 3500;
      expect(Math.abs(start - p.startMarketCapUsd)).to.be.below(1);
      expect(marketCapEthAt(launch, full / 3n, SUPPLY)).to.be.above(marketCapEthAt(launch, 0n, SUPPLY));
    });
  }
});
