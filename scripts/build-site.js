// Usage: node scripts/build-site.js [--local]
// Builds the claim page into _site/: the static files in site/, ethers, and per-network
// data (contract addresses + started airdrop rounds) from deployments/ and airdrop/.
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
fs.mkdirSync(path.join(out, "data"));

const roundDirs = fs.existsSync(path.join(root, "airdrop"))
  ? fs.readdirSync(path.join(root, "airdrop")).filter((d) => /^round-\d+$/.test(d))
  : [];

for (const [name, meta] of Object.entries(NETWORKS)) {
  const file = path.join(root, "deployments", name === "localhost" ? "localhost.local.json" : `${name}.json`);
  if (!fs.existsSync(file) || (name === "localhost" && !local)) continue;
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const rounds = [];
  for (const dir of roundDirs) {
    const claimsFile = path.join(root, "airdrop", dir, "claims.json");
    if (!fs.existsSync(claimsFile)) continue;
    const claims = JSON.parse(fs.readFileSync(claimsFile, "utf8"));
    const started = claims.started?.[name];
    if (!started) continue;
    const rel = `airdrop/${dir}/claims.json`;
    fs.mkdirSync(path.join(out, "airdrop", dir), { recursive: true });
    fs.writeFileSync(path.join(out, rel), JSON.stringify({ root: claims.root, claims: claims.claims }));
    rounds.push({ round: claims.round, file: rel, ...started });
  }

  const data = {
    network: name,
    chainId: d.chainId,
    ...meta,
    contracts: {
      KujiraToken: d.KujiraToken,
      KujiraPod: d.KujiraPod,
      KujiraDrop: d.KujiraDrop,
      VestingWallet: d.VestingWallet?.address || null,
    },
    rounds,
  };
  fs.writeFileSync(path.join(out, "data", `${name}.json`), JSON.stringify(data, null, 2) + "\n");
  console.log(`${name}: ${rounds.length} round(s)`);
}
console.log(`Built ${path.relative(process.cwd(), out)}/`);
