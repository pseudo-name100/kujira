// Edit these before deploying. Percentages must add up to 100.
module.exports = {
  allocations: {
    liquidity: 70, // stays with the deployer to pair on a DEX, then lock or burn the LP
    stakingRewards: 15, // deposited into KujiraPod and streamed to stakers
    team: 10, // vested to TEAM_ADDRESS
    community: 5, // stays with the deployer for airdrops / giveaways
  },
  // First staking reward period
  rewardDurationDays: 180,
  // Team vesting: nothing for `teamCliffDays`, then linear over `teamVestingDays`
  teamCliffDays: 180,
  teamVestingDays: 365,
};
