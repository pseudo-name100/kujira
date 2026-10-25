// Edit these before deploying. Percentages must add up to 100.
// Ryoshi's way: no team allocation. Everything not in liquidity goes to holders.
module.exports = {
  allocations: {
    liquidity: 55, // sent to LIQUIDITY_ADDRESS to pair on a DEX, then burn or lock the LP
    stakingRewards: 20, // deposited into KujiraPod and streamed to stakers
    airdrop: 25, // locked in KujiraDrop and released in claim-based rounds
  },
  // First staking reward period
  rewardDurationDays: 180,

  // Liquidity goes in a 1% Uniswap v3 pool. The position NFT is sent to KujiraLiquidityLock,
  // which keeps the liquidity forever and sends the pool's trading fees to FEE_RECIPIENT.
  uniswapV3: {
    ink: {
      positionManager: "0xC0836E5B058BBE22ae2266e1AC488A1A0fD8DCE8",
      factory: "0x640887A9ba3A9C53Ed27D0F7e8246A4F933f3424",
      router: "0x177778F19E89dD1012BdBe603F144088A95C4B53", // SwapRouter02
      weth: "0x4200000000000000000000000000000000000006",
      fee: 10000, // 1%
    },
  },
};
