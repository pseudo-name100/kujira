// Usage: node scripts/render-song.js   (needs Playwright's Chromium)
// Renders site/song.js to site/audio/song.wav with an OfflineAudioContext.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>render</title>");
  await page.addScriptTag({ path: path.join(__dirname, "..", "site", "song.js") });
  const b64 = await page.evaluate(async () => {
    const rate = 22050;
    const ac = new OfflineAudioContext(1, Math.ceil(window.KujiraSong.LENGTH * rate), rate);
    window.KujiraSong.synth(ac);
    const buf = await ac.startRendering();
    const pcm = buf.getChannelData(0);
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    const gain = peak > 0 ? 0.89 / peak : 1; // normalise to about -1 dBFS
    // 16-bit mono WAV
    const data = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const str = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); data.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
    data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
    str(36, "data"); data.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i] * gain)) * 0x7fff, true);
    let bin = "";
    const bytes = new Uint8Array(data.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  await browser.close();
  const out = path.join(__dirname, "..", "site", "audio", "song.wav");
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
})();
