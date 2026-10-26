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
