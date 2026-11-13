// Usage: node art/kujira3d/shoot.js   (serves the repo on :8090; needs Playwright's Chromium)
// Renders the 3D Kujira from several angles to art/kujira3d/out/<view>.png.
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..", "..");
const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webp": "image/webp", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(8090, "127.0.0.1", r));
  const out = path.join(__dirname, "out");
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("http://127.0.0.1:8090/art/kujira3d/studio.html");
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  for (const [view, t] of [["side", 0.4], ["front34", 0.9], ["front", 0.2], ["back34", 1.6], ["top", 0.7]]) {
    await page.evaluate(([v, t]) => window.render(v, t), [view, t]);
    await page.locator("canvas").screenshot({ path: path.join(out, `${view}.png`) });
  }
  console.log("errors:", errors.length ? errors : "none");
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exitCode = 1; server.close(); });
