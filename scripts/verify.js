// Usage: npx hardhat run scripts/verify.js --network ink
// Publishes the source of every contract in deployments/<network>.json on Ink's explorer.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function verify(label, address, constructorArguments, contract) {
  try {
    await hre.run("verify:verify", { address, constructorArguments, contract });
    console.log(`${label}: verified`);
  } catch (e) {
    if (/already verified/i.test(e.message)) console.log(`${label}: already verified`);
    else throw e;
  }
}

async function main() {
  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8")
  );
  await verify("KujiraToken", d.KujiraToken, d.tokenArgs);
  await verify("KujiraPod", d.KujiraPod, [d.KujiraToken, d.deployer]);
  await verify("KujiraDrop", d.KujiraDrop, [d.KujiraPod, d.deployer]);
  if (d.KujiraLiquidityLock) {
    const { uniswapV3 } = require("./tokenomics");
    await verify("KujiraLiquidityLock", d.KujiraLiquidityLock, [
      uniswapV3[hre.network.name].positionManager,
      d.KujiraToken,
      uniswapV3[hre.network.name].weth,
      d.feeRecipient,
    ]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
