const { parseEther } = require("ethers");

// Round settings. Round numbers here are 1-based; on-chain round ids start at 0.
module.exports = {
  explorerApi: "https://explorer.inkonchain.com/api/v2",
  rpcUrl: process.env.INK_RPC_URL || "https://rpc-gel.inkonchain.com",

  rounds: {
    1: {
      // Out of the 100M pool. Keep early rounds small.
      total: parseEther("10000000"),
      claimDays: 30,
      stakeBonusBps: 2500, // claim-and-stake gets +25%

      eligibility: {
        // DEX routers to count. Leave empty to use airdrop/round-<n>/routers.json from
        // discover-routers.js; entries here are added on top of that file.
        routers: [
          // { name: "Example DEX router", address: "0x..." },
        ],
        discovery: {
          slices: 24, // sample slices spread evenly over the window
          blocksPerSlice: 10000, // ~2.8 hours each at 1s blocks
          minSenders: 10, // distinct wallets in the sample
          minSwapShare: 0.8, // share of the contract's latest 50 transactions that are swaps
        },
        // Only count swaps in this window (ISO dates, UTC).
        from: "2026-01-01",
        to: "2026-10-25",
        // Sybil and bot filters
        minSwaps: 3,
        minActiveDays: 2, // distinct UTC days with at least one swap
        maxSwaps: 5000, // above this is almost certainly a bot
        exclude: [], // addresses to leave out (team, deployer, known bots)
      },

      // Allocation weight = min(activeDays, maxWeightDays). Days are harder to fake
      // than raw swap counts, and the cap keeps whales from taking the whole round.
      maxWeightDays: 10,
    },
  },
};
