const { parseEther } = require("ethers");

// Round settings. Round numbers here are 1-based; on-chain round ids start at 0.
module.exports = {
  explorerApi: "https://explorer.inkonchain.com/api/v2",

  rounds: {
    1: {
      // Out of the 100M pool. Keep early rounds small.
      total: parseEther("10000000"),
      claimDays: 30,
      stakeBonusBps: 2500, // claim-and-stake gets +25%

      eligibility: {
        // Router contracts of the Ink DEXes to count. Traders send their swap
        // transactions to these, so their senders are the traders. Take the addresses
        // from each DEX's official docs and check them on explorer.inkonchain.com.
        routers: [
          // { name: "Example DEX router", address: "0x..." },
        ],
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
