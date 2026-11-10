// Usage: node video/render.js [--preview]   (needs Playwright's Chromium and ffmpeg)
// Renders video/scene.html to video/out/kujira-village.mp4: 1080x1080, 30 fps, 24 s, H.264 +
// AAC, the format X plays inline. --preview writes a few stills instead, for a quick look.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const FPS = 30, LENGTH = 24;
const out = path.join(__dirname, "out");

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
  await page.goto("file://" + path.join(__dirname, "scene.html"));
  await page.evaluate(() => window.ready());
  const frame = async (t) => {
    await page.evaluate((t) => window.render(t), t);
    return (await page.locator("#c").screenshot({ type: "png" }));
  };

  if (process.argv.includes("--preview")) {
    for (const t of [7, 13.2, 15, 16.4, 18.5, 22.5]) fs.writeFileSync(path.join(out, `still-${t}.png`), await frame(t));
    console.log(`stills in ${path.relative(process.cwd(), out)}`);
    await browser.close();
    return;
  }

  const wav = path.join(out, "soundtrack.wav");
  fs.writeFileSync(wav, Buffer.from(await page.evaluate(() => window.soundtrack()), "base64"));
  console.log(`soundtrack: ${path.relative(process.cwd(), wav)}`);

  const mp4 = path.join(out, "kujira-village.mp4");
  const ff = spawn("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-i", wav,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "slow", "-crf", "18",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart",
    mp4,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => ff.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`)))));
  const total = FPS * LENGTH;
  for (let i = 0; i < total; i++) {
    const png = await frame(i / FPS);
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % FPS === 0) process.stdout.write(`\r  frame ${i}/${total}`);
  }
  ff.stdin.end();
  await done;
  await browser.close();
  console.log(`\nWrote ${path.relative(process.cwd(), mp4)} (${(fs.statSync(mp4).size / 1048576).toFixed(1)} MB)`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
