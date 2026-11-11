// Usage: PRIVY_APP_SECRET=... node scripts/airdrop/collect-signups.js <round>
// For rounds with a `signups` part: reads everyone who logged in on kujira.ink from Privy's
// API and keeps those who linked an X account before the deadline (signupsFromPrivyUsers):
// one share per X account, paid to their own wallet or the one Privy made for them. Writes
// airdrop/round-<n>/signups.csv with wallet addresses only; X handles stay private.
const fs = require("fs");
const path = require("path");
const { rounds } = require("./config");
const { roundDir, signupsFromPrivyUsers, writeCsv } = require("./lib");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function privyUsers(appId, secret) {
  const auth = "Basic " + Buffer.from(`${appId}:${secret}`).toString("base64");
  const users = [];
  let cursor = null;
  for (;;) {
    const url = `https://auth.privy.io/api/v1/users?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    let res;
    for (let i = 1; ; i++) {
      res = await fetch(url, { headers: { Authorization: auth, "privy-app-id": appId } }).catch(() => null);
      if (res?.ok) break;
      if (res && (res.status === 401 || res.status === 403)) throw new Error("Privy refused the app ID or secret (check PRIVY_APP_SECRET)");
      if (i >= 6) throw new Error(`Privy API: ${res?.status ?? "network error"}`);
      await sleep(1000 * 2 ** i);
    }
    const page = await res.json();
    users.push(...(page.data || []));
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return users;
}

async function main() {
  const round = process.argv[2];
  const cfg = rounds[round];
  if (!cfg?.signups) throw new Error(`round ${round} has no signups config`);
  const appId = process.env.PRIVY_APP_ID || JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "site", "config.json"), "utf8")).privyAppId;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!appId || !secret) throw new Error("set PRIVY_APP_SECRET (and a privyAppId in site/config.json)");

  const until = Math.floor(Date.parse(cfg.signups.until) / 1000);
  if (Date.now() / 1000 < until) console.warn(`Sign-ups are still open until ${cfg.signups.until}; this list is provisional.`);
  const deployment = path.join(__dirname, "..", "..", "deployments", "ink.json");
  const d = fs.existsSync(deployment) ? JSON.parse(fs.readFileSync(deployment, "utf8")) : {};
  const exclude = [d.deployer, d.feeRecipient, d.liquidity, ...(cfg.signups.exclude || [])];

  const users = await privyUsers(appId, secret);
  const rows = signupsFromPrivyUsers(users, { until, exclude });
  const dir = roundDir(round);
  fs.mkdirSync(dir, { recursive: true });
  writeCsv(path.join(dir, "signups.csv"), ["address"], rows.map((r) => ({ address: r.address })));
  console.log(`${users.length} Privy users; ${rows.length} signed up with X by ${cfg.signups.until}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { privyUsers };
