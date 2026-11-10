const { expect } = require("chai");
const { read, send, notSent } = require("../scripts/rpc");

const fast = { tries: 5, delayMs: 1 };
const tx = (status = 1) => ({ hash: "0xabc", wait: async () => ({ status }) });

describe("rpc retries", function () {
  it("retries a read until the RPC catches up", async function () {
    let calls = 0;
    const v = await read(async () => {
      if (++calls < 3) throw new Error('could not decode result data (value="0x")');
      return 42;
    }, fast);
    expect(v).to.equal(42);
    expect(calls).to.equal(3);
  });

  it("retries a send whose gas estimate reverted, since nothing was sent", async function () {
    let calls = 0;
    await send("fund", async () => {
      if (++calls < 3) throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" });
      return tx();
    }, fast);
    expect(calls).to.equal(3);
  });

  it("never retries a send that may have gone out", async function () {
    let calls = 0;
    const err = Object.assign(new Error("request timeout"), { code: "TIMEOUT" });
    await expect(send("transfer", async () => { calls++; throw err; }, fast)).to.be.rejectedWith("request timeout");
    expect(calls).to.equal(1);
    expect(notSent({ code: "CALL_EXCEPTION", receipt: { status: 0 } })).to.equal(false); // reverted on-chain
  });

  it("fails loudly when a sent transaction reverts", async function () {
    await expect(send("mint", async () => tx(0), fast)).to.be.rejectedWith("mint failed");
  });
});
