// Renders each artboard in templates.html to brand/out/<id>.png at its exact size.
// Usage: node brand/render.js   (needs Playwright's Chromium)
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

(async () => {
  const out = path.join(__dirname, "out");
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  await page.goto("file://" + path.join(__dirname, "templates.html"));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  for (const board of await page.$$(".board")) {
    const id = await board.getAttribute("id");
    await board.screenshot({ path: path.join(out, `${id}.png`) });
    console.log(`brand/out/${id}.png`);
  }
  await browser.close();
})();
