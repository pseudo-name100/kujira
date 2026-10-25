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
fs.mkdirSync(path.join(out, "fonts"));
for (const w of [300, 400, 600, 800]) {
  fs.copyFileSync(
    path.join(root, "node_modules/@fontsource/poppins/files", `poppins-latin-${w}-normal.woff2`),
    path.join(out, "fonts", `poppins-${w}.woff2`)
  );
}
const { allocations } = require("./tokenomics");
fs.writeFileSync(path.join(out, "data", "site.json"), JSON.stringify({ allocations }, null, 2) + "\n");

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
    // Split the proofs into 256 files by the address's first byte, so a visitor only
    // downloads the slice their wallet is in.
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
    rounds.push({ round: claims.round, root: claims.root, dir: rel, ...started });
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
