// Ink's public RPC sits behind a load balancer. A read made right after a transaction can land
// on a server a block behind, which answers as if the transaction hadn't happened: empty code
// for a contract just deployed, an old allowance, a stale nonce. These helpers retry until the
// chain has caught up.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry a read until it succeeds (up to about a minute). */
async function read(fn, { tries = 20, delayMs = 3000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(delayMs);
    }
  }
}

// Errors that mean the transaction was never broadcast, so sending again is safe: the gas
// estimate ran against a server that hadn't seen an earlier transaction yet (a revert), or it
// handed out a nonce that's already used. Anything else (a timeout, a dropped connection) might
// have broadcast it, so it's never retried.
function notSent(e) {
  if (e?.receipt || e?.transactionHash) return false;
  const text = `${e?.code ?? ""} ${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
  return /CALL_EXCEPTION|BAD_DATA|execution reverted|nonce too low|nonce has already been used/i.test(text);
}

/** Send a transaction and wait for it, retrying only when it certainly wasn't sent. */
async function send(label, fn, { tries = 20, delayMs = 3000 } = {}) {
  for (let i = 1; ; i++) {
    let tx;
    try {
      tx = await fn();
    } catch (e) {
      if (i >= tries || !notSent(e)) throw e;
      console.log(`  ${label}: the RPC isn't caught up yet, retrying`);
      await sleep(delayMs);
      continue;
    }
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`${label} failed in transaction ${tx.hash}`);
    return { tx, receipt };
  }
}

/** Wait until a contract's code is visible to the RPC. */
async function deployed(provider, address) {
  await read(async () => {
    if ((await provider.getCode(address)) === "0x") throw new Error(`no code at ${address} yet`);
  });
}

module.exports = { read, send, deployed, notSent };
