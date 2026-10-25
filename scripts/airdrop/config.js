const { parseEther } = require("ethers");

// Round settings. Round numbers here are 1-based; on-chain round ids start at 0.
module.exports = {
  explorerApi: "https://explorer.inkonchain.com/api/v2",
  explorerRpcApi: "https://explorer.inkonchain.com/api", // Etherscan-style endpoints
  rpcUrl: process.env.INK_RPC_URL || "https://rpc-gel.inkonchain.com",

  rounds: {
    1: {
      // Tokens the round takes from the 200M pool.
      total: parseEther("80000000"),
      // Most listed wallets never claim, so allocations add up to `oversubscribe` times
      // `total` while only `total` is reserved. Claims are first come, first served: once
      // `total` (plus stake bonuses) is paid out, later claims fail. 2.5 covers a claim
      // rate up to 40% of the listed amount.
      oversubscribe: 2.5,
      // If set, every eligible wallet is listed for exactly this amount instead of a
      // weighted share of `total * oversubscribe`. Only `total` is still reserved.
      amountEach: parseEther("81766"),
      claimDays: 30,
      stakeBonusBps: 2500, // claim-and-stake gets +25%

      eligibility: {
        // DEX routers to count. Leave empty to use airdrop/round-<n>/routers.json from
        // discover-routers.js; entries here are added on top of that file.
        routers: [
          // Velodrome's router also handles liquidity, so discovery's 80%-swaps test drops it.
          { name: "Velodrome UniversalRouter", address: "0x01D40099fCD87C018969B0e8D4aB1633Fb34763C" },
        ],
        // Never count these, even if discovery picks them up.
        excludeRouters: [
          {
            address: "0x3E23E075f27a2c67Eda58790121e22B2aae2a4d9",
            reason: "Wallet farm: all txs in one 50-minute burst on 2026-10-13 from scripted wallets",
          },
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
