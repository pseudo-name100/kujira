// Usage: node scripts/airdrop/collect-dex-traders.js <round>
// Pulls every transaction sent to the DEX routers (routers.json plus config) from Ink's
// explorer and writes airdrop/round-<n>/traders.csv with the wallets that pass the filters.
const fs = require("fs");
const path = require("path");
const { explorerRpcApi, rounds } = require("./config");
const { roundDir, createAggregator, filterTraders, writeCsv } = require("./lib");

const PAGE = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 6) {
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { accept: "application/json" } }).catch(() => null);
    if (res?.ok) {
      const body = await res.json().catch(() => null);
      // The Etherscan-style API reports rate limits as status "0" with a message.
      if (body && !(body.status === "0" && /rate|limit|timeout/i.test(String(body.result ?? body.message)))) {
        return body;
      }
    }
    if (i >= tries) throw new Error(`${res?.status ?? "network error"} for ${url}`);
    await sleep(1000 * 2 ** i);
  }
}

// Block number at a unix time, from the explorer.
async function blockAt(ts) {
  const r = await getJson(`${explorerRpcApi}?module=block&action=getblocknobytime&timestamp=${ts}&closest=before`);
  return Number(r.result.blockNumber);
}

// Every transaction sent to `router` between two blocks. Uses the explorer's
// Etherscan-style API (up to 10,000 per request) and walks forward by block number.
async function routerTransactions(router, fromBlock, toBlock, onTx) {
  let count = 0;
  let seen = new Set(); // hashes from the block the previous page ended in
  let start = fromBlock;
  for (;;) {
    const url =
      `${explorerRpcApi}?module=account&action=txlist&address=${router}` +
      `&startblock=${start}&endblock=${toBlock}&page=1&offset=${PAGE}&sort=asc`;
    const page = await getJson(url);
    const items = Array.isArray(page.result) ? page.result : [];
    for (const it of items) {
      if (seen.has(it.hash) || (it.to || "").toLowerCase() !== router.toLowerCase()) continue;
      seen.add(it.hash);
      count += 1;
      onTx({
        hash: it.hash,
        from: it.from,
        fromIsContract: false, // transaction senders are always externally owned accounts
        timestamp: new Date(Number(it.timeStamp) * 1000).toISOString(),
        ok: it.isError === "0" && it.txreceipt_status !== "0",
      });
    }
    process.stdout.write(`\r  ${count} txs (up to block ${items.at(-1)?.blockNumber ?? start})`);
    if (items.length < PAGE) break;
    // A full page can end mid-block, so restart at that block; `seen` drops the repeats.
    const last = Number(items.at(-1).blockNumber);
    if (last === start) throw new Error(`more than ${PAGE} txs in block ${start} for ${router}`);
    seen = new Set(items.filter((it) => Number(it.blockNumber) === last).map((it) => it.hash));
    start = last;
    await sleep(250);
  }
  process.stdout.write("\n");
  return count;
}

async function main() {
  const round = process.argv[2];
  const cfg = rounds[round];
  if (!cfg) throw new Error(`no config for round ${round} in scripts/airdrop/config.js`);
  const e = cfg.eligibility;

  const discovered = path.join(roundDir(round), "routers.json");
  const routers = [...e.routers];
  if (fs.existsSync(discovered)) routers.push(...JSON.parse(fs.readFileSync(discovered, "utf8")).routers);
  const excluded = new Set((e.excludeRouters || []).map((r) => r.address.toLowerCase()));
  const unique = [...new Map(routers.map((r) => [r.address.toLowerCase(), r])).values()].filter(
    (r) => !excluded.has(r.address.toLowerCase())
  );
  if (unique.length === 0) throw new Error("run discover-routers.js or add addresses to eligibility.routers");

  const fromBlock = await blockAt(Math.floor(Date.parse(e.from) / 1000));
  const toBlock = await blockAt(Math.floor(Date.parse(e.to) / 1000) + 86400);
  console.log(`Window ${e.from} to ${e.to}: blocks ${fromBlock}-${toBlock}`);

  const agg = createAggregator(e);
  let total = 0;
  for (const r of unique) {
    console.log(`${r.name} (${r.address})`);
    total += await routerTransactions(r.address, fromBlock, toBlock, (tx) => agg.add(tx));
  }

  const traders = filterTraders(agg.result(), e);
  const file = path.join(roundDir(round), "traders.csv");
  writeCsv(file, ["address", "swaps", "activeDays"], traders);
  console.log(`${total} router txs, ${traders.length} eligible wallets -> ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
