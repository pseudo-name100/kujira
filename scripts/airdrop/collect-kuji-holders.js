// Usage: node scripts/airdrop/collect-kuji-holders.js <round>
// Snapshot for whale-only rounds: every KUJI holder's wallet balance (from Ink's explorer)
// plus their Pod stake (from the Pod contract), written to airdrop/round-<n>/holders.csv.
// Contracts (the DEX pool, the Pod, the Drop), the burn address and the liquidity wallet
// are left out.
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Contract, id, getAddress, formatEther } = require("ethers");
const { rounds } = require("./config");
const { roundDir, mergeHolders, writeCsv } = require("./lib");

const NETWORKS = {
  ink: {
    rpc: process.env.INK_RPC_URL || "https://rpc-gel.inkonchain.com",
    explorer: "https://explorer.inkonchain.com",
  },
  inkSepolia: {
    rpc: process.env.INK_SEPOLIA_RPC_URL || "https://rpc-gel-sepolia.inkonchain.com",
    explorer: "https://explorer-sepolia.inkonchain.com",
  },
};
const STAKED = id("Staked(address,uint256)");
const BURN = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 6) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { accept: "application/json" } }).catch(() => null);
    if (res?.ok) return res.json();
    if (i >= tries) throw new Error(`${res?.status ?? "network error"} for ${url}`);
    await sleep(1000 * 2 ** i);
  }
}

// Every holder of the token with its balance, from the explorer's holder list.
async function tokenHolders(explorer, token) {
  const out = [];
  let params = {};
  for (;;) {
    const page = await getJson(`${explorer}/api/v2/tokens/${token}/holders?${new URLSearchParams(params)}`);
    for (const it of page.items || []) {
      out.push({ address: it.address.hash, balance: BigInt(it.value), isContract: Boolean(it.address.is_contract) });
    }
    process.stdout.write(`\r  ${out.length} holders`);
    if (!page.next_page_params) break;
    params = page.next_page_params;
    await sleep(250);
  }
  process.stdout.write("\n");
  return out;
}

// Everyone who ever staked, from the Pod's Staked events; then their current stake.
async function podStakes(explorer, provider, pod) {
  const stakers = new Set();
  for (let page = 1; ; page++) {
    const r = await getJson(
      `${explorer}/api?module=logs&action=getLogs&address=${pod}&topic0=${STAKED}` +
        `&fromBlock=0&toBlock=latest&page=${page}&offset=1000`
    );
    const logs = Array.isArray(r.result) ? r.result : [];
    for (const l of logs) stakers.add(getAddress("0x" + l.topics[1].slice(26)));
    if (logs.length < 1000) break;
    await sleep(250);
  }
  const c = new Contract(pod, ["function balanceOf(address) view returns (uint256)"], provider);
  const list = [...stakers];
  const out = [];
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    const bals = await Promise.all(chunk.map((a) => c.balanceOf(a)));
    chunk.forEach((address, j) => bals[j] > 0n && out.push({ address, staked: bals[j] }));
  }
  console.log(`  ${out.length} wallets staked in the Pod`);
  return out;
}

async function main() {
  const round = process.argv[2];
  const cfg = rounds[round];
  if (!cfg) throw new Error(`no config for round ${round} in scripts/airdrop/config.js`);
  const network = cfg.network || "ink";
  const net = NETWORKS[network];
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "deployments", `${network}.json`), "utf8"));
  const provider = new JsonRpcProvider(net.rpc);

  console.log(`KUJI holders on ${network} (token ${d.KujiraToken})`);
  const wallets = await tokenHolders(net.explorer, d.KujiraToken);
  const stakes = await podStakes(net.explorer, provider, d.KujiraPod);
  const exclude = [
    d.KujiraToken,
    d.KujiraPod,
    d.KujiraDrop,
    d.deployer,
    d.liquidity,
    ...BURN,
    ...(cfg.eligibility?.exclude || []),
  ];
  const rows = mergeHolders(wallets, stakes, exclude);

  const file = path.join(roundDir(round), "holders.csv");
  writeCsv(
    file,
    ["address", "wallet", "staked", "held"],
    rows.map((r) => ({ address: r.address, wallet: formatEther(r.wallet), staked: formatEther(r.staked), held: formatEther(r.held) }))
  );
  fs.writeFileSync(
    path.join(roundDir(round), "snapshot.json"),
    JSON.stringify({ network, takenAt: new Date().toISOString(), block: await provider.getBlockNumber() }, null, 2) + "\n"
  );
  console.log(`${rows.length} holders -> ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
