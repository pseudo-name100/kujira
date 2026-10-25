// The Drop never outgrows the market. Before a round starts, everything the Drop has handed
// out or reserved, plus the new round, must fit within a share of the KUJI that buyers have
// taken out of the launch pool. Buyers bring ETH for every KUJI they take, so this keeps
// what the Drop can put on the market in step with what the market has already absorbed.
const { kujiBought, marketCapEthAt, ethPriceUsd } = require("../uniswap");
const { dropCap } = require("./config");

async function checkDropCap(ethers, deployment, drop, newReserve) {
  const launch = deployment.launch;
  if (!launch) throw new Error("the pool hasn't launched yet: run Launch pool first");

  let committed = 0n;
  const count = Number(await drop.roundCount());
  for (let i = 0; i < count; i++) {
    const r = await drop.rounds(i);
    committed += r.closed ? r.paid : r.reserved;
  }
  const { bought } = await kujiBought(ethers, launch);
  const need = committed + newReserve;
  const allowed = (bought * BigInt(dropCap.shareOfBoughtBps)) / 10_000n;
  const neededBought = (need * 10_000n + BigInt(dropCap.shareOfBoughtBps) - 1n) / BigInt(dropCap.shareOfBoughtBps);

  const fmt = (x) => Math.round(Number(ethers.formatEther(x))).toLocaleString("en-US");
  const supply = 10n ** 27n;
  const ethUsd = await ethPriceUsd().catch(() => launch.ethUsdAtLaunch);
  const usd = (b) => "$" + Math.round(marketCapEthAt(launch, b, supply) * ethUsd).toLocaleString("en-US");

  console.log(`Buyers have taken ${fmt(bought)} KUJI from the pool (market cap about ${usd(bought)}).`);
  console.log(`The Drop has committed ${fmt(committed)} KUJI; this round adds up to ${fmt(newReserve)}.`);
  if (need <= allowed) {
    console.log(`Within the cap: ${dropCap.shareOfBoughtBps / 100}% of bought KUJI allows ${fmt(allowed)}.`);
    return;
  }
  const reachable = neededBought < BigInt(launch.kujiAdded);
  throw new Error(
    `the market can't carry this round yet. It needs buyers to have taken ${fmt(neededBought)} KUJI ` +
      (reachable ? `(a market cap of about ${usd(neededBought)}). ` : "(more than the pool holds). ") +
      "Nothing was started."
  );
}

module.exports = { checkDropCap };
