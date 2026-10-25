// Usage: node scripts/build-site.js [--local]
// Builds the site into _site/: the static files in site/, ethers, fonts, every airdrop list,
// and per-network data (contract addresses + started rounds) from deployments/ and airdrop/.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "_site");
const local = process.argv.includes("--local");

const NETWORKS = {
  ink: { chainName: "Ink", rpc: "https://rpc-gel.inkonchain.com", explorer: "https://explorer.inkonchain.com" },
  inkSepolia: {
    chainName: "Ink Sepolia",
    rpc: "https://rpc-gel-sepolia.inkonchain.com",
    explorer: "https://explorer-sepolia.inkonchain.com",
  },
  localhost: { chainName: "Localhost", rpc: "http://127.0.0.1:8545", explorer: "http://127.0.0.1:8545" },
};

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, "site"), out, { recursive: true });
fs.copyFileSync(require.resolve("ethers").replace(/lib\.commonjs.*$/, "dist/ethers.umd.min.js"), path.join(out, "ethers.umd.min.js"));
// Privy login bundle (wallet/), loaded by the page only when config.json has an App ID.
if (fs.existsSync(path.join(root, "wallet", "node_modules"))) {
  require("child_process").execFileSync(process.execPath, [path.join(root, "wallet", "build.js"), path.join(out, "wallet")], {
    stdio: "inherit",
  });
} else {
  console.warn("wallet/node_modules missing: run `npm ci --prefix wallet` to include Privy login");
}
fs.mkdirSync(path.join(out, "data"));
// site/fonts/ holds the Japanese subsets (only the kanji the site uses); Latin comes from fontsource.
fs.mkdirSync(path.join(out, "fonts"), { recursive: true });
const fonts = {
  "dela-400": "dela-gothic-one/files/dela-gothic-one-latin-400-normal.woff2",
  "zen-400": "zen-kaku-gothic-new/files/zen-kaku-gothic-new-latin-400-normal.woff2",
  "zen-500": "zen-kaku-gothic-new/files/zen-kaku-gothic-new-latin-500-normal.woff2",
  "zen-700": "zen-kaku-gothic-new/files/zen-kaku-gothic-new-latin-700-normal.woff2",
};
for (const [name, file] of Object.entries(fonts)) {
  fs.copyFileSync(path.join(root, "node_modules/@fontsource", file), path.join(out, "fonts", `${name}.woff2`));
}
const roundDirs = fs.existsSync(path.join(root, "airdrop"))
  ? fs.readdirSync(path.join(root, "airdrop")).filter((d) => /^round-\d+$/.test(d))
  : [];

// Every round's list is published, started or not, so the page's checker works before
// launch. Proofs are split into 256 files by the address's first byte, so a visitor only
// downloads the slice their wallet is in.
const lists = [];
const claimsByDir = {};
for (const dir of roundDirs) {
  const claimsFile = path.join(root, "airdrop", dir, "claims.json");
  if (!fs.existsSync(claimsFile)) continue;
  const claims = JSON.parse(fs.readFileSync(claimsFile, "utf8"));
  claimsByDir[dir] = claims;
  const rel = `airdrop/${dir}/claims`;
  const shards = {};
  for (const [addr, c] of Object.entries(claims.claims)) {
    (shards[addr.slice(2, 4).toLowerCase()] ||= {})[addr] = c;
  }
  fs.mkdirSync(path.join(out, rel), { recursive: true });
  for (let i = 0; i < 256; i++) {
    const key = i.toString(16).padStart(2, "0");
    fs.writeFileSync(path.join(out, rel, `${key}.json`), JSON.stringify(shards[key] || {}));
  }
  lists.push({ round: claims.round, root: claims.root, dir: rel, wallets: Object.keys(claims.claims).length });
}
lists.sort((a, b) => a.round - b.round);

const { allocations } = require("./tokenomics");
const { rounds: roundCfg, dropCap } = require("./airdrop/config");
function nextRound(started) {
  const done = new Set(started.map((r) => r.round));
  const next = lists.find((l) => !done.has(l.round) && roundCfg[l.round]);
  if (!next) return null;
  const total = BigInt(claimsByDir[`round-${next.round}`].total);
  const reserve = total + (total * BigInt(roundCfg[next.round].stakeBonusBps)) / 10000n;
  return { round: next.round, reserve: reserve.toString() };
}
const networks = Object.keys(NETWORKS).filter((name) =>
  name === "localhost" ? local && fs.existsSync(path.join(root, "deployments", "localhost.local.json")) : fs.existsSync(path.join(root, "deployments", `${name}.json`))
);
fs.writeFileSync(path.join(out, "data", "site.json"), JSON.stringify({ allocations, lists, networks }, null, 2) + "\n");

for (const [name, meta] of Object.entries(NETWORKS)) {
  const file = path.join(root, "deployments", name === "localhost" ? "localhost.local.json" : `${name}.json`);
  if (!fs.existsSync(file) || (name === "localhost" && !local)) continue;
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const rounds = [];
  for (const [dir, claims] of Object.entries(claimsByDir)) {
    const started = claims.started?.[name];
    if (started) rounds.push({ round: claims.round, root: claims.root, dir: `airdrop/${dir}/claims`, ...started });
  }

  const data = {
    network: name,
    chainId: d.chainId,
    ...meta,
    contracts: {
      KujiraToken: d.KujiraToken,
      KujiraPod: d.KujiraPod,
      KujiraDrop: d.KujiraDrop,
      KujiraLiquidityLock: d.KujiraLiquidityLock || null,
    },
    rounds,
    launch: d.launch || null,
    // The next built-but-unstarted round and the Drop cap it has to fit under (gate.js).
    nextRound: nextRound(rounds),
    dropCapBps: dropCap.shareOfBoughtBps,
  };
  fs.writeFileSync(path.join(out, "data", `${name}.json`), JSON.stringify(data, null, 2) + "\n");
  console.log(`${name}: ${rounds.length} round(s)`);
}
console.log(`Built ${path.relative(process.cwd(), out)}/`);
