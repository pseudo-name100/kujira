const { expect } = require("chai");
const { aggregateTraders, filterTraders, allocate } = require("../scripts/airdrop/lib");

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";

let n = 0;
const tx = (from, timestamp, extra = {}) => ({
  hash: `0x${(n++).toString(16)}`,
  from,
  fromIsContract: false,
  timestamp,
  ok: true,
  ...extra,
});

describe("airdrop eligibility", function () {
  const window = { from: "2026-01-01", to: "2026-01-31" };

  it("counts swaps and distinct days, skipping failures, contracts, duplicates and out-of-window", function () {
    const dup = tx(A, "2026-01-05T10:00:00Z");
    const txs = [
      dup,
      dup,
      tx(A, "2026-01-05T12:00:00Z"),
      tx(A, "2026-01-31T23:59:00Z"), // last day is inclusive
      tx(A, "2026-02-01T00:00:00Z"), // outside
      tx(A, "2026-01-06T00:00:00Z", { ok: false }),
      tx(B, "2026-01-07T00:00:00Z", { fromIsContract: true }),
    ];
    const [a, ...rest] = aggregateTraders(txs, window);
    expect(rest).to.have.length(0);
    expect(a.swaps).to.equal(3);
    expect(a.activeDays).to.equal(2);
  });

  it("drops excluded addresses regardless of case", function () {
    const res = aggregateTraders([tx(A, "2026-01-05T00:00:00Z")], { ...window, exclude: [A.toUpperCase().replace("0X", "0x")] });
    expect(res).to.have.length(0);
  });

  it("applies min and max filters", function () {
    const traders = [
      { address: A, swaps: 5, activeDays: 3 },
      { address: B, swaps: 2, activeDays: 2 }, // too few swaps
      { address: C, swaps: 9000, activeDays: 30 }, // bot
    ];
    const res = filterTraders(traders, { minSwaps: 3, minActiveDays: 2, maxSwaps: 5000 });
    expect(res.map((t) => t.address)).to.deep.equal([A]);
  });

  it("weights by capped active days and never exceeds the total", function () {
    const res = allocate(
      [
        { address: A, activeDays: 30 }, // capped to 10
        { address: B, activeDays: 5 },
        { address: C, activeDays: 5 },
      ],
      1000n,
      10
    );
    expect(res.map((r) => r.amount)).to.deep.equal([500n, 250n, 250n]);
    const odd = allocate([{ address: A, activeDays: 1 }, { address: B, activeDays: 2 }], 100n, 10);
    expect(odd.reduce((s, r) => s + r.amount, 0n)).to.be.lte(100n);
  });
});

describe("whale rounds", function () {
  const { mergeHolders, allocateWeighted } = require("../scripts/airdrop/lib");
  const D = "0x00000000000000000000000000000000000000d4";
  const P = "0x00000000000000000000000000000000000000e5";

  it("adds wallet and Pod balances, drops contracts, exclusions and empty rows", function () {
    const rows = mergeHolders(
      [
        { address: A, balance: 5n, isContract: false },
        { address: B, balance: 7n, isContract: true }, // e.g. the DEX pool
        { address: P, balance: 100n, isContract: false }, // excluded below
        { address: D, balance: 0n, isContract: false },
      ],
      [
        { address: A, staked: 10n },
        { address: C, staked: 3n }, // staked everything, nothing in the wallet
        { address: C, staked: 1n },
      ],
      [P]
    );
    expect(rows).to.deep.equal([
      { address: require("ethers").getAddress(A), wallet: 5n, staked: 10n, held: 15n },
      { address: require("ethers").getAddress(C), wallet: 0n, staked: 4n, held: 4n },
    ]);
  });

  it("splits by weight without exceeding the total", function () {
    const res = allocateWeighted(
      [
        { address: A, weight: 3n },
        { address: B, weight: 1n },
      ],
      1000n
    );
    expect(res.map((r) => r.amount)).to.deep.equal([750n, 250n]);
  });
});

describe("holding rounds", function () {
  const { snapshotBlocks, holdingWeights } = require("../scripts/airdrop/lib");
  const M = 10n ** 24n; // 1M KUJI
  const D = "0x00000000000000000000000000000000000000d4";
  const seed = "0x" + "52".repeat(32);

  it("picks one block inside each part of the window, reproducibly", function () {
    const blocks = snapshotBlocks(seed, 1000, 1400, 4);
    expect(blocks).to.have.length(4);
    blocks.forEach((b, i) => {
      expect(b).to.be.gte(1000 + i * 100);
      expect(b).to.be.lt(1000 + (i + 1) * 100);
    });
    expect(snapshotBlocks(seed, 1000, 1400, 4)).to.deep.equal(blocks);
    expect(snapshotBlocks("0x" + "53".repeat(32), 1000, 1400, 4)).to.not.deep.equal(blocks);
  });

  it("counts each wallet at its lowest, rewards Pod boosts, and caps whales", function () {
    const snap = (rows) => new Map(Object.entries(rows));
    const s1 = snap({
      [A]: { wallet: 2n * M }, // steady holder
      [B]: { staked: 2n * M, boosted: 5n * M }, // staked at 2.5x
      [C]: { wallet: 0n }, // bought in for one snapshot only
      [D]: { wallet: 50n * M }, // giant
    });
    const s2 = snap({ [A]: { wallet: 3n * M }, [B]: { staked: 2n * M, boosted: 5n * M }, [C]: { wallet: 9n * M }, [D]: { wallet: 50n * M } });
    const s3 = snap({ [A]: { wallet: 2n * M }, [B]: { staked: 2n * M, boosted: 5n * M }, [D]: { wallet: 50n * M } });
    const rows = holdingWeights([s1, s2, s3], { minHeld: M, cap: 10n * M });
    const w = Object.fromEntries(rows.map((r) => [r.address, r.weight]));
    expect(w[A]).to.equal(2n * M); // lowest of 2M, 3M, 2M
    expect(w[B]).to.equal(5n * M); // 2M staked at 2.5x
    expect(w[C]).to.equal(undefined); // held 0 at two snapshots
    expect(w[D]).to.equal(10n * M); // capped
  });
});

describe("round 1: KUJI buyers who hold", function () {
  const { buyerWeights, mergeAllocations } = require("../scripts/airdrop/lib");
  const K = 10n ** 18n;
  const D = "0x00000000000000000000000000000000000000d4";
  const snap = (rows) => new Map(Object.entries(rows));

  it("counts the least of bought, held at every snapshot, and the cap", function () {
    const bought = new Map([
      [A, 500_000n * K], // bought and held
      [B, 500_000n * K], // bought, then sold half before a snapshot
      [C, 500_000n * K], // bought and dumped
      [D, 50_000n * K], // too small
    ]);
    const s1 = snap({ [A]: { wallet: 500_000n * K }, [B]: { wallet: 500_000n * K }, [C]: { wallet: 0n }, [D]: { wallet: 50_000n * K } });
    const s2 = snap({ [A]: { wallet: 200_000n * K, staked: 400_000n * K }, [B]: { wallet: 250_000n * K }, [D]: { wallet: 50_000n * K } });
    const rows = buyerWeights(bought, [s1, s2], { minBought: 100_000n * K, cap: 10_000_000n * K });
    const w = Object.fromEntries(rows.map((r) => [r.address, r.weight]));
    expect(w[A]).to.equal(500_000n * K); // held 500K then 600K (wallet + Pod): counts what it bought
    expect(w[B]).to.equal(250_000n * K); // its lowest
    expect(w[C]).to.equal(undefined);
    expect(w[D]).to.equal(undefined);
  });

  it("adds a wallet's shares from both parts of the round", function () {
    const merged = mergeAllocations([{ address: A, amount: 5n }], [{ address: A, amount: 2n }, { address: B, amount: 1n }]);
    const m = Object.fromEntries(merged.map((r) => [r.address.toLowerCase(), r.amount]));
    expect(m[A]).to.equal(7n);
    expect(m[B]).to.equal(1n);
  });
});

describe("round 1: X sign-ups", function () {
  const { signupsFromPrivyUsers } = require("../scripts/airdrop/lib");
  const W = (n) => "0x" + n.repeat(40);
  const x = (subject, at = 100) => ({ type: "twitter_oauth", subject, username: "u" + subject, first_verified_at: at });
  const wallet = (addr, client, at = 100) => ({ type: "wallet", chain_type: "ethereum", address: addr, wallet_client_type: client, first_verified_at: at });

  it("counts one share per X account, paid to the person's own wallet first", function () {
    const users = [
      { created_at: 1, linked_accounts: [x("1"), wallet(W("a"), "privy", 90), wallet(W("b"), "metamask", 120)] }, // own wallet wins
      { created_at: 2, linked_accounts: [x("2"), wallet(W("c"), "privy")] }, // newcomer: Privy wallet
      { created_at: 3, linked_accounts: [wallet(W("d"), "metamask")] }, // no X: not counted
      { created_at: 4, linked_accounts: [x("4", 999), wallet(W("e"), "privy")] }, // linked X after the deadline
      { created_at: 5, linked_accounts: [x("5"), wallet(W("c"), "rabby")] }, // same wallet as another sign-up
      { created_at: 6, linked_accounts: [x("6"), wallet(W("f"), "privy")] }, // excluded (project wallet)
    ];
    const res = signupsFromPrivyUsers(users, { until: 500, exclude: [W("f")] });
    expect(res.map((r) => r.address.toLowerCase())).to.deep.equal([W("b"), W("c")]);
  });
});

describe("caps and the Tide", function () {
  const { capWeighted, tideShares } = require("../scripts/airdrop/lib");
  const M = 10n ** 24n;

  it("matches buyers 1:1 when the pot is bigger than what they hold, leaving the rest", function () {
    const res = capWeighted([{ address: A, weight: 10n * M }, { address: B, weight: 2n * M }], 105n * M);
    expect(res.map((r) => r.amount)).to.deep.equal([10n * M, 2n * M]); // 93M left unused
  });

  it("splits by weight when holdings outgrow the pot, never above the match", function () {
    const res = capWeighted([{ address: A, weight: 150n * M }, { address: B, weight: 60n * M }], 105n * M);
    expect(res.map((r) => r.amount)).to.deep.equal([75n * M, 30n * M]);
    res.forEach((r, i) => expect(r.amount <= [150n, 60n][i] * M).to.equal(true));
  });

  it("gives the Tide in equal shares to people who held the floor all month", function () {
    const K = 10n ** 18n;
    const snap = (rows) => new Map(Object.entries(rows));
    const s1 = snap({ [A]: { wallet: 200_000n * K }, [B]: { staked: 150_000n * K }, [C]: { wallet: 500_000n * K } });
    const s2 = snap({ [A]: { wallet: 120_000n * K }, [B]: { staked: 150_000n * K }, [C]: { wallet: 50_000n * K } }); // C dipped
    const res = tideShares([{ address: A }, { address: B }, { address: C }], [s1, s2], { minHeld: 100_000n * K, budget: 4n * M });
    expect(res).to.deep.equal([{ address: A, amount: 2n * M }, { address: B, amount: 2n * M }]);
  });
});
