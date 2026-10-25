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
