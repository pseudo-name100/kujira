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
};
