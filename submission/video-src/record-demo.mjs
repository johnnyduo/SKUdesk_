import { chromium } from '/Library/WebServer/Documents/SKUdesk/node_modules/playwright-core/index.mjs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
const [,, OUT, BASE = 'https://skudesk.lol'] = process.argv;
const VOICE = process.env.TTS_VOICE || 'en-US-Chirp3-HD-Aoede';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rects = [];
let clock = () => 0;
const mark = async (p, sel, label) => {
  try {
    const loc = p.locator(sel).first();
    await loc.scrollIntoViewIfNeeded({ timeout: 4000 });
    await sleep(350);
    const b = await loc.boundingBox();
    if (!b) return;
    const x = Math.max(0, b.x), y = Math.max(0, b.y);
    const w = Math.min(1920, b.x + b.width) - x, h = Math.min(1080, b.y + b.height) - y;
    if (w > 40 && h > 20) rects.push({ t: clock(), x, y, w, h, label });
  } catch { /* a missing target only means no zoom there */ }
};
const card = (h1, h2, h3 = '') => `<style>html{background:#000}</style><body style="margin:0;min-height:100vh;background:#000;color:#fff;font-family:Helvetica,Arial,sans-serif;display:grid;place-items:center;height:100vh;text-align:center"><div><div style="font-size:92px;font-weight:700">${h1}</div><div style="font-size:34px;margin-top:22px;color:#ccff00">${h2}</div><div style="font-size:24px;margin-top:40px;color:#9aa3b2">${h3}</div></div></body>`;
const type = async (p, q) => { await p.click('#query'); await p.locator('#query').pressSequentially(q, { delay: 65 }); await sleep(500); await p.click('#desk form button[type=submit]'); };

const VO = JSON.parse(readFileSync(new URL('./script3.json', import.meta.url)));
const SEGS = [
  { id: 'open', say: 'SKUdesk. One agent that finds the cheapest price, works out what a resale would keep, and checks for arbitrage. Only on the exact same product.',
    run: async (p) => { await p.setContent(card('SKUdesk', 'One price you can trust, only for the same item.', 'Chonlarnatt Poonchattakarn · Ploypitcha Boontavipitak')); } },
  { id: 'why', say: "Here's the problem. A cheap listing is only a deal if it's the same item. Price sites mix up an iPhone 16 and a 16 Pro, or a phone and its case. We check that first, and a person approves every purchase.",
    run: async (p) => { await p.goto(BASE + '/', { waitUntil: 'networkidle' }); await sleep(1500); await mark(p, 'h1', 'Identity first'); await sleep(2500); } },
  { id: 'run', say: "Let's try a Apple iPhone 14, 128 gigabytes. The agent searches Google Shopping right now. Gemini reads every listing and decides if it's the same phone. Watch the graph: each result lights it up. Green is the same phone, red is a different one.",
    run: async (p) => { await p.goto(BASE + '/app/', { waitUntil: 'networkidle' }); await sleep(1000); await type(p, 'Apple iPhone 16e 128GB'); await p.waitForSelector('.run', { timeout: 15000 }); await mark(p, '.run', 'Live graph'); await p.waitForSelector('.verdict', { timeout: 120000 }); } },
  { id: 'verdict', say: "Then Gemini looks at each photo, and our code checks that the words it quoted are really in the listing. Here's the answer: the cheapest identical price, the cost of reselling it, and every listing we turned down, with the reason. These are asking prices from Google Shopping.",
    run: async (p) => { await p.locator('.verdict').scrollIntoViewIfNeeded(); await sleep(1200); await mark(p, '.verdict', 'The answer'); await sleep(1500); for (let i = 0; i < 6; i++) { await p.mouse.wheel(0, 260); await sleep(1000); } } },
  { id: 'pixel', say: "Not every check ends in a deal. For the Pixel 9 Pro, nothing could be proven identical, so the agent says no. We think an honest no is more useful than a wrong yes.",
    run: async (p) => { await p.goto(BASE + '/app/', { waitUntil: 'networkidle' }); await sleep(800); await type(p, 'Google Pixel 9 Pro 256GB'); await p.waitForSelector('.verdict', { timeout: 90000 }); await p.locator('.verdict').scrollIntoViewIfNeeded(); await sleep(1000); await mark(p, '.verdict', 'No identical product, no buy'); } },
  { id: 'market', say: "The market page shows what the agent knows. Sellers' prices sit on the book, with the gap. Below them, four buyer strategies bid what they could pay after costs. A deal needs a bid that reaches the best price. You can also turn the product around in 3D.",
    run: async (p) => { await p.goto(BASE + '/market/?key=4bf902dd3f8f0a', { waitUntil: 'networkidle' }); await sleep(3000); await mark(p, 'section[aria-label="Offer book"]', 'Asks, spread and bids'); await sleep(2800); await p.evaluate(() => window.scrollTo(0, 0)); await sleep(600); await mark(p, '.mk-p3d', 'Drag to turn'); const b = await p.locator('.mk-p3d canvas').first().boundingBox().catch(() => null); if (b) { const cx = b.x + b.width / 2, cy = b.y + b.height / 2; await p.mouse.move(cx, cy); await p.mouse.down(); for (let i = 0; i < 26; i++) { await p.mouse.move(cx + i * 6, cy + Math.sin(i / 3) * 6); await sleep(40); } await p.mouse.up(); } await sleep(800); await mark(p, 'section[aria-label="Price chart"]', 'Price history'); await sleep(1800); } },
  { id: 'switch', say: "Every product we watch is in this list, each with its own book and its own price history. A scheduler checks them for us, around the clock.",
    run: async (p) => { await p.evaluate(() => window.scrollTo(0, 0)); await sleep(700); await mark(p, '[data-testid=product-picker]', 'Every watched product'); await p.click('[data-testid=product-picker]'); await sleep(1600); await p.locator('.mk-pk-o', { hasText: 'Ferrari' }).first().click(); await sleep(2600); } },
  { id: 'orders', say: "When the agent does find a buy, it files a proposal. Only the person who ran the check, or the owner, can approve it. The agent never spends money by itself.",
    run: async (p) => { await p.goto(BASE + '/app/orders/', { waitUntil: 'networkidle' }); await sleep(1500); await mark(p, 'h2:has-text("Waiting for a decision")', 'A person decides'); await sleep(1500); for (let i = 0; i < 3; i++) { await p.mouse.wheel(0, 240); await sleep(900); } } },
  { id: 'listings', say: "After approval, the owner can list the resale in Google Merchant Center. It's previewed first, and this is a real, connected account.",
    run: async (p) => { await p.goto(BASE + '/app/listings/', { waitUntil: 'networkidle' }); await sleep(1800); await mark(p, 'h2:has-text("Merchant Center")', 'Google Merchant Center'); await sleep(2000); } },
  { id: 'eval', say: "How do we know the gate works? We labelled sixty-seven pairs of listings by hand: phones, LEGO, clones, bundles, even listings with hidden instructions. It made no wrong match, and missed none.",
    run: async (p) => { await p.goto(BASE + '/app/analytics/', { waitUntil: 'networkidle' }); await sleep(1200); await mark(p, '#ev-grid', 'Sixty-seven labelled pairs'); await sleep(2500); for (let i = 0; i < 3; i++) { await p.mouse.wheel(0, 260); await sleep(900); } } },
  { id: 'close', say: "SKUdesk runs on Google Cloud: Cloud Run, Firestore, Scheduler, Secret Manager, Gemini and the Merchant API. It's live at skudesk dot lol. Thanks for watching.",
    run: async (p) => { await p.setContent(card('skudesk.lol', 'Cloud Run · Firestore · Cloud Scheduler · Secret Manager · Gemini · Merchant API', 'github.com/johnnyduo/SKUdesk_')); } },
];

const VDIR = process.env.VDIR || './v3c';
for (const s of SEGS) {
  const v = VO.find((x) => x.id === s.id);
  s.say = v.text;
  s.wav = `${VDIR}/${s.id}.wav`;
  s.dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', s.wav]).toString());
}
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
await page.goto(BASE + '/', { waitUntil: 'networkidle' }); await sleep(800);
mkdirSync(`${OUT}/frames`, { recursive: true });
const cdp = await ctx.newCDPSession(page);
const frames = []; let nf = 0;
cdp.on('Page.screencastFrame', async (e) => {
  const file = `${resolve(OUT)}/frames/f${String(nf++).padStart(6, '0')}.jpg`;
  writeFileSync(file, Buffer.from(e.data, 'base64')); frames.push({ ts: e.metadata.timestamp, file });
  await cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
});
const t0 = Date.now();
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 2 });
clock = () => (Date.now() - t0) / 1000;
const starts = [];
for (const s of SEGS) {
  const at = clock() + 0.4;
  starts.push(at);
  console.log(s.id, at.toFixed(1), 'voice', s.dur.toFixed(1));
  const began = Date.now();
  await s.run(page);
  const left = s.dur + 0.9 - (Date.now() - began) / 1000 - 0.4;
  if (left > 0) await sleep(left * 1000);
}
const total = clock();
await cdp.send('Page.stopScreencast'); await sleep(300);
await ctx.close(); await browser.close();
const z = frames[0].ts - 0.05;
const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[i + 1]?.ts ?? z + total) - f.ts)).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
writeFileSync(`${OUT}/frames.txt`, list);
execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', `${OUT}/frames.txt`, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-t', String(total), `${OUT}/screen.mp4`], { stdio: 'ignore' });
const inputs = SEGS.flatMap((s) => ['-i', s.wav]);
const filt = SEGS.map((s, i) => `[${i}:a]adelay=${Math.round(starts[i] * 1000)}|${Math.round(starts[i] * 1000)}[a${i}]`).join(';') + ';' + SEGS.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${SEGS.length}:normalize=0,loudnorm=I=-16:TP=-1.5[a]`;
execFileSync('ffmpeg', ['-y', ...inputs, '-filter_complex', filt, '-map', '[a]', '-t', String(total), '-c:a', 'aac', '-b:a', '192k', `${OUT}/voice.m4a`], { stdio: 'ignore' });
rmSync(`${OUT}/frames`, { recursive: true, force: true });
writeFileSync(`${OUT}/timing.json`, JSON.stringify({ total, segs: SEGS.map((s, i) => ({ id: s.id, text: s.say, start: starts[i], dur: s.dur })), rects }, null, 1));
console.log('done', total.toFixed(1), 's', rects.length, 'marks', nf, 'frames');
