// Usage: node scripts/airdrop/collect-dex-traders.js <round>
// Pulls every transaction sent to the DEX routers (routers.json plus config) from Ink's Blockscout
// explorer and writes airdrop/round-<n>/traders.csv with the wallets that pass the filters.
const fs = require("fs");
const path = require("path");
const { explorerApi, rounds } = require("./config");
const { roundDir, aggregateTraders, filterTraders, writeCsv } = require("./lib");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 5) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.ok) return res.json();
    if (i >= tries || (res.status < 500 && res.status !== 429)) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
    await sleep(1000 * 2 ** i);
  }
}

async function routerTransactions(router, since) {
  const txs = [];
  let params = { filter: "to" };
  while (params) {
    const url = `${explorerApi}/addresses/${router}/transactions?${new URLSearchParams(params)}`;
    const page = await getJson(url);
    for (const it of page.items) {
      txs.push({
        hash: it.hash,
        from: it.from.hash,
        fromIsContract: Boolean(it.from.is_contract),
        timestamp: it.timestamp,
        ok: it.status === "ok",
      });
    }
    // Newest first: stop once we are past the start of the window.
    const last = page.items[page.items.length - 1];
    if (!last || Date.parse(last.timestamp) < since) break;
    params = page.next_page_params;
    process.stdout.write(`\r  ${txs.length} txs`);
    await sleep(250);
  }
  process.stdout.write("\n");
  return txs;
}

async function main() {
  const round = process.argv[2];
  const cfg = rounds[round];
  if (!cfg) throw new Error(`no config for round ${round} in scripts/airdrop/config.js`);
  const e = cfg.eligibility;
  const discovered = path.join(roundDir(round), "routers.json");
  const routers = [...e.routers];
  if (fs.existsSync(discovered)) routers.push(...JSON.parse(fs.readFileSync(discovered, "utf8")).routers);
  if (routers.length === 0) throw new Error("run discover-routers.js or add addresses to eligibility.routers");

  const all = [];
  const unique = [...new Map(routers.map((r) => [r.address.toLowerCase(), r])).values()];
  for (const r of unique) {
    console.log(`${r.name} (${r.address})`);
    all.push(...(await routerTransactions(r.address, Date.parse(e.from))));
  }

  const traders = filterTraders(aggregateTraders(all, e), e);
  const file = path.join(roundDir(round), "traders.csv");
  writeCsv(file, ["address", "swaps", "activeDays"], traders);
  console.log(`${traders.length} eligible wallets -> ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
