const { parseEther } = require("ethers");

// Round settings. Round numbers here are 1-based; on-chain round ids start at 0.
module.exports = {
  explorerApi: "https://explorer.inkonchain.com/api/v2",
  explorerRpcApi: "https://explorer.inkonchain.com/api", // Etherscan-style endpoints
  rpcUrl: process.env.INK_RPC_URL || "https://rpc-gel.inkonchain.com",

  // The Drop never outgrows the market (gate.js). Everything the Drop has paid or reserved,
  // plus a new round, must be at most this share of the KUJI buyers have taken out of the
  // launch pool. At 50%, round 1 (80M, up to 100M with the stake bonus) opens once buyers
  // have taken 200M KUJI: about a $100k market cap from the $40k start.
  dropCap: { shareOfBoughtBps: 5000 },

  rounds: {
    1: {
      // Tokens the round takes from the 200M pool.
      // Round 1: the first pod. 70% to wallets that bought KUJI and held it, 30% split evenly
      // among Ink DEX traders active in the six months before launch. The list adds up to
      // exactly `total`, so everyone on it is guaranteed their amount (no first-come race).
      total: parseEther("80000000"),
      traderShareBps: 3000, // the Ink-trader part; the rest goes to KUJI buyers
      buyers: {
        until: "2026-12-01T00:00:00Z", // buys from launch to here count; announce it
        snapshots: 3, // hidden, one in each third of the window
        minBought: parseEther("100000"),
        cap: parseEther("10000000"), // anything above 10M counts as 10M
        exclude: [],
      },
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
        // Only count swaps in this window (ISO dates, UTC): the six months before launch.
        from: "2026-05-10",
        to: "2026-11-09",
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

    // Round 2: whales who hold. KUJI holders (wallet + Pod) are read at 4 hidden blocks, one
    // in each week of the window, picked from the hash of the block where the window ends.
    // Each wallet counts at its lowest: it must hold 1M+ (Orca) at every snapshot, KUJI in
    // the Pod counts at its Pod boost (up to 2.5x), and anything above 10M counts as 10M.
    // Announce the window, not the snapshots. Build it after round 1 is closed.
    2: {
      source: "kuji-holders",
      network: "ink",
      snapshots: { count: 4, from: "2026-12-01T00:00:00Z", to: "2026-12-29T00:00:00Z" }, // set when announced
      // Size: everything the Drop has free beyond `keep`, leaving room for the stake bonus.
      // With round 1 fully claimed that's 50M; round 1's leftovers and any launch-tax KUJI
      // sent to the Drop make it bigger. `keep` stays in the Drop for later rounds.
      sizeFromPool: { keep: parseEther("87500000") }, // kept for round 3
      claimDays: 30,
      stakeBonusBps: 2500,
      eligibility: {
        minHeld: parseEther("1000000"), // Orca and up
        exclude: [], // known exchange or bridge wallets
      },
      weightCap: parseEther("10000000"),
    },

    // Round 3: the loyal pod, any size from Dolphin up. Same hidden-snapshot method as round
    // 2 over a longer window: 8 snapshots, one a week, each wallet at its lowest, Pod KUJI at
    // its boost. Takes everything left in the Drop. Build it after round 2 is closed.
    3: {
      source: "kuji-holders",
      network: "ink",
      snapshots: { count: 8, from: "2027-01-05T00:00:00Z", to: "2027-03-02T00:00:00Z" }, // set when announced
      sizeFromPool: { keep: 0n },
      claimDays: 30,
      stakeBonusBps: 2500,
      eligibility: {
        minHeld: parseEther("100000"), // Dolphin and up
        exclude: [],
      },
      weightCap: parseEther("10000000"),
    },
  },
};
