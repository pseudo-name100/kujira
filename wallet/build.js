// Bundles src/privy.jsx for the browser as ES module chunks, so parts of Privy that a
// visitor doesn't use (other wallet SDKs, WalletConnect) only load when needed.
// Usage: node build.js <outdir>   (entry point: <outdir>/wallet.js)
const esbuild = require("esbuild");
const outdir = process.argv[2] || "dist";
esbuild
  .build({
    entryPoints: { wallet: `${__dirname}/src/privy.jsx` },
    outdir,
    bundle: true,
    splitting: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    chunkNames: "chunks/[hash]",
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    metafile: true,
    logLevel: "warning",
  })
  .then(async (r) => {
    const entry = Object.entries(r.metafile.outputs).find(([f]) => f.endsWith("wallet.js"));
    const total = Object.values(r.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
    console.log(`Built ${outdir}/wallet.js: entry ${(entry[1].bytes / 1024).toFixed(0)} KB, all chunks ${(total / 1048576).toFixed(1)} MB`);
  })
  .catch(() => process.exit(1));
