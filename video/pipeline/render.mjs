// Renders the timeline to JPEG frames with Playwright. Resumable: existing frames are skipped.
// Usage: node render.mjs [startFrame]
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// playwright-core is not a dependency of the repo; point PW_PKG at any package.json next to a node_modules that has it.
const require = createRequire(process.env.PW_PKG ?? import.meta.url);
const { chromium } = require('playwright-core');
const DIR = import.meta.dirname;
const FPS = 30;

const data = {};
// renderer-data.js sets window.__DATA in browser; load it here just for the frame count:
const { readFile } = await import('node:fs/promises');
const src = await readFile(path.join(DIR, 'renderer-data.js'), 'utf8');
const total = Number(src.match(/"total":([\d.]+)/)?.[1]);
const frames = Math.ceil(total * FPS);
console.log(`total ${total}s → ${frames} frames at ${FPS} fps`);

await mkdir(path.join(DIR, 'frames'), { recursive: true });
const startFrom = Number(process.argv[2] ?? 0);

const browser = await chromium.launch({ args: ['--force-device-scale-factor=1'] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
await page.goto(`file://${path.join(DIR, 'renderer.html')}`);
await page.waitForFunction(() => window.__ready instanceof Promise);
await page.evaluate(async () => { await window.__ready; });
await page.evaluate((t) => window.__setTime(t), 0);
console.log('renderer ready');

const t0 = Date.now();
let done = 0;
for (let f = startFrom; f < frames; f++) {
  const name = path.join(DIR, 'frames', `${String(f).padStart(5, '0')}.jpg`);
  if (f % 10 === 0 && existsSync(name)) continue; // cheap resume check
  await page.evaluate((t) => window.__setTime(t), f / FPS);
  await page.screenshot({ type: 'jpeg', quality: 93, path: name });
  done++;
  if (done % 100 === 0) {
    const rate = done / ((Date.now() - t0) / 1000);
    console.log(`${f + 1}/${frames}  (${rate.toFixed(1)} fps capture, eta ${(((frames - f) / rate) / 60).toFixed(1)} min)`);
  }
}
console.log('RENDER DONE', frames, 'frames in', ((Date.now() - t0) / 60000).toFixed(1), 'min');
await browser.close();
