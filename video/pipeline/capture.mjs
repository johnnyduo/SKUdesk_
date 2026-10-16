// Captures the stills used by the video from the live site: node --env-file=../../.env capture.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(process.env.PW_PKG ?? import.meta.url);
const { chromium } = require('playwright-core');
const OUT = path.join(import.meta.dirname, 'stills');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE ?? 'https://skudesk.lol/';
const OWNER = process.env.OWNER_KEY ?? '';
const LIVE = process.env.LIVE_QUERY ?? 'LEGO Technic Bugatti Chiron 42083';

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle' }); await page.waitForTimeout(900); };
const scrollTo = async (sel, offset = 120) => { await page.evaluate(([s, o]) => { const el = document.querySelector(s); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - o, behavior: 'instant' }); }, [sel, offset]); await page.waitForTimeout(500); };
const noSticky = () => page.evaluate(() => document.querySelectorAll('.lp-nav, .top').forEach((e) => { e.style.position = 'static'; }));

if (!process.env.SKIP_LIVE) {
// 01 hero (3D ring) and 02 stats
await go('');
await page.mouse.move(900, 500);
await page.waitForTimeout(7000);
await shot('01-hero');
await scrollTo('#tr-h', 140);
await page.waitForTimeout(1800);
await shot('02-stats');

// 03: a live check, caught mid-run while Gemini is still judging listings
await go('app/');
await page.fill('#query', LIVE);
await page.click('#desk form button[type=submit]');
await page.waitForFunction(() => document.querySelectorAll('.wall .chip').length >= 16, null, { timeout: 120000 });
await scrollTo('.run', 120);
await shot('03-run');
await page.waitForSelector('.verdict', { timeout: 150000 });

// 04, 05, 07: a stored Titanic check (7 of 30 passed) so the numbers match the narration; live results drift over time
await page.goto(BASE + 'app/', { waitUntil: 'domcontentloaded' });
const titanic = await page.evaluate(async () => (await (await fetch('/api/analyses?n=100')).json()).find((a) => a.query === 'LEGO 10294 Titanic' && a.identical === 7)?.id ?? '');
if (!titanic) throw new Error('no stored Titanic check with 7 identical offers');
await go(`app/opportunities/view/?id=${titanic}`);
await noSticky();
await scrollTo('.verdict', 40);
await shot('04-verdict');
await scrollTo('.ladder', 200);
await shot('05-ladder');
await page.evaluate(() => { const h = [...document.querySelectorAll('h4')].find((e) => e.textContent.includes('price not trusted')); if (h) window.scrollTo({ top: h.getBoundingClientRect().top + scrollY - 260, behavior: 'instant' }); });
await page.waitForTimeout(500);
await shot('07-titanic');

// 06: a check with a buy, run in this session so the approval buttons are live
await go('app/');
await page.fill('#query', 'LEGO Icons Eiffel Tower 10307');
await page.click('#desk form button[type=submit]');
await page.waitForFunction(() => [...document.querySelectorAll('.v-sub')].some((e) => e.textContent.startsWith('LEGO Icons Eiffel Tower 10307')), null, { timeout: 120000 });
await page.waitForTimeout(1500);
await noSticky();
const appr = await page.evaluate(() => { const h = [...document.querySelectorAll('h3')].find((e) => e.textContent.includes('Needs your approval')); if (h) window.scrollTo({ top: h.getBoundingClientRect().top + scrollY - 260, behavior: 'instant' }); return Boolean(h); });
await page.waitForTimeout(600);
await shot('06-approval');
console.log('approval panel present:', appr);
}

// 08 replay, 09 market
await page.goto(BASE + 'app/', { waitUntil: 'domcontentloaded' });
const tid = await page.evaluate(async () => (await (await fetch('/api/analyses?n=100')).json()).find((a) => a.query === 'LEGO 10294 Titanic' && a.identical === 7)?.id ?? '');
await go(`show/?id=${tid}`);
await page.waitForFunction(() => document.querySelectorAll('.console p').length >= 10, null, { timeout: 60000 });
await noSticky();
await shot('08-show');
const key = await page.evaluate(async () => (await (await fetch('/api/products')).json()).sort((a, b) => b.identical - a.identical)[0]?.key ?? '');
await go(`market/?key=${key}`);
await page.waitForSelector('#ladder .ladder', { timeout: 30000 });
await page.waitForTimeout(800);
await shot('09-market');

// 10, 11 deck slides (element screenshots at 1.5x so they fill 1920x1080)
const deck = await ctx.newPage();
await deck.setViewportSize({ width: 1300, height: 760 });
await deck.goto(BASE + 'deck/', { waitUntil: 'networkidle' });
await deck.waitForTimeout(800);
const slideShot = async (i, name) => {
  const el = deck.locator('.slide').nth(i);
  await el.scrollIntoViewIfNeeded();
  const buf = await el.screenshot();
  const big = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await big.setContent(`<body style="margin:0;background:#080908"><img src="data:image/png;base64,${buf.toString('base64')}" style="width:1920px;height:1080px;display:block"></body>`);
  await big.screenshot({ path: path.join(OUT, `${name}.png`) });
  await big.close();
};
await slideShot(3, '10-deck-evidence');
await slideShot(6, '11-deck-zero');
await deck.close();

// 12 owner console (unlocked through sessionStorage, the key is never on screen), 13 limits simulator, 14 deployment
await page.goto(BASE + 'app/owner/', { waitUntil: 'networkidle' });
await page.evaluate((k) => sessionStorage.setItem('skudesk.owner', k), OWNER);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await noSticky();
await shot('12-owner');
await page.evaluate(() => sessionStorage.removeItem('skudesk.owner'));
await go('app/policies/');
await page.click('#sim button[type=submit]');
await page.waitForSelector('#result .verdict', { timeout: 15000 });
await noSticky();
await scrollTo('#sim-h', 120);
await shot('13-limits');
await go('app/deploy/');
await page.waitForFunction(() => document.querySelectorAll('#parts tr').length >= 4);
await noSticky();
await shot('14-deploy');
await browser.close();
console.log('stills done');
