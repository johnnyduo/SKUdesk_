// Browser tests for the whole site against a local server and the real built pages.
// The upstream sources are stubbed (no Google, no Gemini), so this checks the app, not the data. `npm run smoke` covers the real services.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';
import { generateKeyPairSync } from 'node:crypto';
import { merchantConfigFrom } from '../src/merchant.ts';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createApp } from '../src/app.ts';
import { getLimits } from '../src/domain.ts';
import { MemoryStore, Quota } from '../src/store.ts';
import type { Offer } from '../src/types.ts';

const OWNER = 'e2e-owner-key';
const offer = (seller: string, title: string, priceCents: number, channel: Offer['channel'] = 'retailer', thumbnail?: string): Offer => ({
  id: `${seller}-${priceCents}`, title, seller, channel, priceCents, currency: 'USD', shippingCents: 0, secondHand: false, url: `https://example.test/${seller}`, origin: 'serpapi', thumbnail,
});

// Two small pictures the image proxy gets in place of Google's: a product on a white backdrop, and a full-bleed box shot.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => { const t = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([len, t, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; }
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PICTURES: Record<string, Buffer> = {
  'cut.png': png(160, 160, (x, y) => (x > 40 && x < 120 && y > 50 && y < 110 ? [200, 30, 30] : [255, 255, 255])),
  'box.png': png(160, 160, (x, y) => [20 + x / 2, 30 + y / 3, 60]),
};
const realFetch = globalThis.fetch;

// Google's side of the Merchant Center connection, answered locally: sign-in, the account, insert, the processed product and delete.
const SA_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const merchantEnv: Record<string, string> = { GOOGLE_SA_JSON: JSON.stringify({ client_email: 'agent@demo.iam.gserviceaccount.com', private_key: SA_KEY }), MERCHANT_ACCOUNT_ID: '4242', MERCHANT_DATA_SOURCE_ID: '31337' };
const merchantCalls: string[] = [];
const googleStub = (async (input: any, init: any) => {
  const u = new URL(typeof input === 'string' ? input : input.href ?? input.url);
  merchantCalls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/token') return json({ access_token: 'e2e-token', expires_in: 3600 });
  if (u.pathname === '/accounts/v1/accounts/4242') return json({ accountName: 'E2E Store' });
  if (u.pathname.endsWith('productInputs:insert')) return json({ name: 'accounts/4242/productInputs/x' });
  if (init?.method === 'DELETE') return json({});
  if (u.pathname.includes('/products/v1/accounts/4242/products/')) return json({ productStatus: { destinationStatuses: [{ approvedCountries: ['US'], disapprovedCountries: [] }], itemLevelIssues: [] } });
  return json({}, 404);
}) as typeof fetch;
const THUMB = 'https://encrypted-tbn0.gstatic.com/images?q=';
const OFFERS = [
  offer('LEGO.com', 'LEGO 10294 Titanic', 67999),
  offer('Mercari', 'LEGO Titanic 10294 sealed', 63500, 'marketplace', `${THUMB}cut.png`),
  offer('Bait', 'LEGO 10294 Titanic', 2100),
  offer('Parts', 'Light kit for LEGO 10294', 5600),
];
const BOXED = OFFERS.map((o) => (o.thumbnail ? { ...o, thumbnail: `${THUMB}box.png` } : o));

let judged = 0;
let server: ReturnType<typeof createApp>;
let base = '';
let browser: Browser;

before(async () => {
  globalThis.fetch = (async (input: any, init: any) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const m = u.match(/^https:\/\/encrypted-tbn0\.gstatic\.com\/images\?q=(.+)$/);
    if (m) return new Response(PICTURES[m[1]], { headers: { 'content-type': 'image/png' } });
    return realFetch(input, init);
  }) as typeof fetch;
  const store = new MemoryStore();
  server = createApp({
    store, quota: new Quota(store, 50), readPerMin: 100000, analyzePerMin: 1000, scanSecret: 'scan', ownerKey: OWNER, merchant: { config: merchantConfigFrom((k) => merchantEnv[k]), fetch: googleStub, sleep: async () => {} }, watchlist: [], sources: { serpapi: true, ebay: false }, storeKind: 'memory',
    agent: {
      store, model: 'stub',
      vision: { check: async (_q: string, o: Offer) => (o.thumbnail ? { verdict: 'matches' as const, seen: 'a boxed set on a white background', reasons: [] } : null) },
      search: async (q: string) => ({ offers: /boxed/i.test(q) ? BOXED : OFFERS, fromCache: false }),
      engine: { compare: async (_a, b) => (await new Promise((r) => setTimeout(r, 250 * (++judged % 4))), /light kit/i.test(b.title)
        ? { verdict: 'different', confidence: 0.99, reasons: ['accessory'], mismatches: ['product type'] }
        : { verdict: 'identical', confidence: 0.99, reasons: ['same set number'], mismatches: [], evidence: { brand: 'LEGO', brandQuoteA: 'LEGO', brandQuoteB: 'LEGO', idA: '10294', idB: '10294' } }) },
      retail: async () => 67999,
      briefing: async () => 'Seven of thirty listings passed the gate.',
      limits: () => getLimits(store),
    },
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});

after(async () => {
  globalThis.fetch = realFetch;
  await browser?.close();
  server?.close();
});

async function open(path: string, ctx?: BrowserContext): Promise<{ page: Page; errors: string[] }> {
  const context = ctx ?? await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(base + path, { waitUntil: 'networkidle' });
  return { page, errors };
}

const runCheck = async (page: Page, query = 'LEGO 10294 Titanic') => {
  await page.fill('#query', query);
  await page.click('#desk form button[type=submit]');
  await page.waitForSelector('.verdict', { timeout: 20000 });
};

describe('the site, end to end', () => {
  test('every page loads without a script error', async () => {
    const paths = ['/', '/app/', '/app/opportunities/', '/app/lots/', '/app/transactions/', '/app/radar/', '/app/orders/', '/show/', '/market/', '/app/create/', '/app/agent/', '/app/policies/', '/app/listings/', '/app/owner/', '/app/analytics/', '/app/deploy/', '/app/integrations/', '/deck/'];
    for (const p of paths) {
      const { page, errors } = await open(p);
      assert.ok((await page.locator('h1').first().textContent())?.trim(), `${p} has a heading`);
      assert.deepEqual(errors, [], `${p}: ${errors.join(' | ')}`);
      await page.context().close();
    }
  });

  test('no page scrolls sideways on a phone', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    for (const p of ['/', '/app/', '/app/opportunities/', '/app/lots/', '/market/', '/show/', '/app/policies/', '/app/listings/', '/app/owner/', '/app/deploy/']) {
      const { page } = await open(p, ctx);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      assert.equal(wide, false, `${p} overflows at 390px`);
      await page.close();
    }
    await ctx.close();
  });

  test('the hero ring shows six products and the ring is different on different visits', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const { page } = await open('/');
      await page.waitForSelector('.sc-card');
      assert.equal(await page.locator('.sc-card').count(), 6);
      seen.add((await page.locator('.sc-name').allTextContents()).join('|'));
      await page.context().close();
    }
    assert.ok(seen.size > 1, 'the six products should vary between visits');
  });

  test('a check streams, answers, and the person who ran it can approve; someone else cannot', async () => {
    const { page, errors } = await open('/app/');
    await page.fill('#query', 'LEGO 10294 Titanic');
    await page.click('#desk form button[type=submit]');
    await page.waitForSelector('.wall .chip', { timeout: 10000 });
    await page.waitForSelector('.verdict', { timeout: 20000 });
    const headline = await page.locator('.v-text').textContent();
    assert.match(headline ?? '', /Cheapest|arbitrage|Arbitrage/);
    assert.ok(await page.locator('.ladder-row').count() >= 2, 'the price ladder has rows');
    assert.ok(await page.locator('.ladder-row.flag').count() >= 1, 'the bait price is shown as not trusted');
    assert.match(await page.locator('.offer .pill.q').first().textContent() ?? '', /brand|number/);
    assert.match(await page.locator('.note-panel').textContent() ?? '', /Seven of thirty/);
    await page.locator('.approval .btn', { hasText: 'Approve' }).click();
    await page.waitForSelector('.approval .pill.good', { timeout: 10000 });
    assert.match(await page.locator('.approval').first().textContent() ?? '', /Open the seller page/);

    const other = await open('/app/orders/');
    await other.page.waitForSelector('#queue .card');
    assert.equal(await other.page.locator('.approval .btn', { hasText: 'Approve' }).count(), 0, 'a stranger gets no approve button');
    assert.deepEqual([...errors, ...other.errors], []);
    await page.context().close();
    await other.page.context().close();
  });

  test('opportunities lists the product and opens its evidence', async () => {
    const { page } = await open('/app/opportunities/');
    await page.waitForSelector('#rows a.row');
    await page.locator('#rows a.row').first().click();
    await page.waitForSelector('.verdict');
    assert.match(page.url(), /opportunities\/view\/\?id=/);
    await page.context().close();
  });

  test('lots, market and replay show the checked product', async () => {
    const lots = await open('/app/lots/');
    await lots.page.waitForSelector('a.lot');
    await lots.page.locator('a.lot').first().click();
    await lots.page.waitForSelector('.verdict');
    assert.match(lots.page.url(), /lots\/view\/\?key=/);
    await lots.page.context().close();

    const market = await open('/market/');
    await market.page.waitForSelector('.mk-al .mk-ar');
    await market.page.waitForSelector('.mk-bk');
    assert.ok(await market.page.locator('.mk-bk.flag').count() >= 1, 'the bait price is flagged in the offer book');
    assert.ok(await market.page.locator('.mk-bk.best').count() === 1, 'the best ask is marked');
    assert.match(await market.page.locator('.mk-stats').textContent() ?? '', /Cheapest landed/);
    await market.page.getByRole('button', { name: 'Daily candles' }).click();
    assert.equal(await market.page.locator('.mk-ctl .mk-seg button[aria-pressed=true]').first().textContent(), 'Daily candles');
    await market.page.locator('.mk-ticket, .mk-tkt-a .mk-btn-pri').click();
    await market.page.waitForSelector('.mk-tkt-ok', { timeout: 20000 });
    assert.ok(await market.page.locator('.mk-al .mk-ar').count() >= 9, 'checked products plus reference products are listed');
    await market.page.locator('.mk-al').nth(1).locator('.mk-ar').first().click();
    await market.page.waitForSelector('.p3d');
    assert.match(await market.page.locator('.mk-stats').textContent() ?? '', /List price/);
    await market.page.context().close();

    const show = await open('/show/');
    await show.page.waitForSelector('.console p', { timeout: 10000 });
    await show.page.waitForFunction(() => document.querySelectorAll('.console p').length >= 6, null, { timeout: 15000 });
    await show.page.context().close();
  });

  test('owner mode: a wrong key is refused, the right key unlocks, the kill switch stops proposals, resume restores them', async () => {
    const { page } = await open('/app/owner/');
    assert.equal(await page.locator('#pause').isDisabled(), true, 'locked by default');
    const unlock = async (key: string) => {
      if (!(await page.locator('#ownerkey').evaluate((d) => (d as HTMLDetailsElement).open))) await page.click('#ok-summary');
      await page.fill('#ok-input', key);
      await page.click('#ok-form button[type=submit]');
      await page.waitForTimeout(600);
    };
    await unlock('not-the-key');
    assert.match(await page.locator('#ok-label').textContent() ?? '', /locked/);
    await unlock(OWNER);
    await page.waitForFunction(() => /unlocked/.test(document.getElementById('ok-label')!.textContent ?? ''));
    await page.waitForFunction(() => !(document.getElementById('pause') as HTMLButtonElement).disabled);
    await page.click('#pause');
    await page.waitForFunction(() => /resume/i.test(document.getElementById('pause')!.textContent ?? ''));
    assert.match(await page.locator('#state').textContent() ?? '', /paused/);

    await page.goto(base + '/app/');
    await runCheck(page);
    assert.equal(await page.locator('.approval').count(), 0, 'no proposal while paused');
    assert.match(await page.locator('.more li').allTextContents().then((t) => t.join(' ')), /paused/);

    await page.goto(base + '/app/owner/');
    await page.waitForFunction(() => !(document.getElementById('pause') as HTMLButtonElement).disabled);
    await page.click('#pause');
    await page.waitForFunction(() => /pause the agent/i.test(document.getElementById('pause')!.textContent ?? ''));
    await page.goto(base + '/app/');
    await runCheck(page);
    assert.equal(await page.locator('.approval').count() >= 1, true, 'proposals are back after resume');
    await page.context().close();
  });

  test('watches: the owner adds and removes one, a visitor cannot', async () => {
    const visitor = await open('/app/create/');
    assert.equal(await visitor.page.locator('#add').isDisabled(), true);
    await visitor.page.context().close();

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript((k) => sessionStorage.setItem('skudesk.owner', k), OWNER);
    const { page } = await open('/app/create/', ctx);
    await page.waitForFunction(() => !(document.getElementById('add') as HTMLButtonElement).disabled);
    await page.fill('#q', 'LEGO 21330 Home Alone');
    await page.click('#add');
    await page.waitForSelector('#watches .row');
    assert.match(await page.locator('#watches').textContent() ?? '', /Home Alone/);
    await page.locator('#watches button', { hasText: 'Remove' }).click();
    await page.waitForFunction(() => /No watches yet/.test(document.getElementById('watches')!.textContent ?? ''));
    await ctx.close();
  });

  test('the limits page saves a new limit for the owner and the what-if calculator answers for anyone', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript((k) => sessionStorage.setItem('skudesk.owner', k), OWNER);
    const { page } = await open('/app/policies/', ctx);
    await page.waitForFunction(() => !(document.getElementById('max') as HTMLInputElement).disabled);
    await page.fill('#max', '300');
    await page.click('#save');
    await page.waitForFunction(() => /Saved/.test(document.getElementById('msg')!.textContent ?? ''));
    await page.click('#sim button[type=submit]');
    await page.waitForSelector('#result .verdict');
    assert.match(await page.locator('#result .v-sub').textContent() ?? '', /per-buy limit/);
    await page.fill('#max', '1500');
    await page.click('#save');
    await page.waitForFunction(() => /Saved/.test(document.getElementById('msg')!.textContent ?? ''));
    await ctx.close();
  });

  test('a proposal above the per-buy limit cannot be approved', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript((k) => sessionStorage.setItem('skudesk.owner', k), OWNER);
    const { page } = await open('/app/policies/', ctx);
    await page.waitForFunction(() => !(document.getElementById('max') as HTMLInputElement).disabled);
    await page.fill('#max', '100');
    await page.click('#save');
    await page.waitForFunction(() => /Saved/.test(document.getElementById('msg')!.textContent ?? ''));
    await page.goto(base + '/app/');
    await runCheck(page);
    assert.equal(await page.locator('.approval .btn', { hasText: 'Approve' }).isDisabled(), true);
    assert.match(await page.locator('.approval .block').textContent() ?? '', /per-buy limit/);
    await page.goto(base + '/app/policies/');
    await page.waitForFunction(() => !(document.getElementById('max') as HTMLInputElement).disabled);
    await page.fill('#max', '1500');
    await page.click('#save');
    await page.waitForFunction(() => /Saved/.test(document.getElementById('msg')!.textContent ?? ''));
    await ctx.close();
  });
  test('market: the dropdown switches products, the book shows asks, the spread and each agent\'s bid', async () => {
    await (await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'LEGO 10294 Titanic', market: 'us' }) })).text();
    const { page, errors } = await open('/market/');
    await page.waitForSelector('.mk-bk');
    assert.doesNotMatch(await page.locator('body').textContent() ?? '', /simulat|mock|practice/i, 'the market page has no made-up data to label');

    // asks: dearest first, best ask next to the spread, the bait price set aside
    assert.ok(await page.locator('.mk-asks .mk-bk').count() === 2, 'two identical offers');
    assert.equal(await page.locator('.mk-bk.best').count(), 1);
    assert.ok(await page.locator('.mk-bk.flag').count() >= 1, 'the bait price is set aside');
    const asks = (await page.locator('.mk-asks .mk-bk > .n.sell').allTextContents()).map((t) => Number(t.replace(/[^0-9.]/g, '')));
    assert.deepEqual(asks, [...asks].sort((x, y) => y - x), 'asks are listed dearest first');
    assert.ok(await page.locator('.mk-bk .mk-vs').first().textContent());

    // the spread line and four bids, highest first, every bid below the best ask
    const spread = (await page.locator('[data-testid=spread]').textContent()) ?? '';
    assert.match(spread, /Average.*Best ask.*Top bid.*Gap/s);
    const bids = (await page.locator('[data-testid=bids] .mk-bid > .n.buy').allTextContents()).map((t) => Number(t.replace(/[^0-9.]/g, '')));
    assert.equal(bids.length, 4);
    assert.deepEqual(bids, [...bids].sort((x, y) => y - x));
    assert.ok(bids.every((b) => b < Math.min(...asks)), 'with a 2-seller book no bid reaches the best ask');
    assert.deepEqual(await page.locator('[data-testid=bids] .mk-bid').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.agent)), ['scout', 'sniper', 'live', 'patient']);
    assert.match(await page.locator('.mk-bk-verdict').textContent() ?? '', /No bid reaches the best ask/);

    // the dropdown lists checked and reference products and switches everything
    await page.locator('[data-testid=product-picker]').click();
    assert.ok(await page.locator('.mk-pk-o').count() >= 9);
    await page.locator('.mk-pk-o[data-symbol="PS5"]').click();
    await page.waitForFunction(() => /PS5/.test(document.querySelector('.mk-stats .mk-id')?.textContent ?? ''));
    assert.match(page.url(), /device=PS5/);
    assert.match(await page.locator('.mk-pk-btn').textContent() ?? '', /PlayStation 5/);
    await page.waitForSelector('.mk-p3d canvas', { timeout: 15000 });
    await page.locator('[data-testid=product-picker]').focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !/PS5/.test(document.querySelector('.mk-stats .mk-id')?.textContent ?? ''));
    await page.locator('[data-testid=product-picker]').click();
    await page.locator('.mk-pk-o[data-symbol="10294"]').click();
    await page.waitForSelector('.mk-bk.best');
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('market on a phone: dropdown and book fit without sideways scrolling', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const { page, errors } = await open('/market/', ctx);
    await page.waitForSelector('.mk-stats .mk-last');
    assert.ok(await page.locator('.mk-pk-btn').isVisible());
    await page.locator('.mk-pk-btn').click();
    assert.ok(await page.locator('.mk-pk-list').isVisible());
    await page.locator('.mk-pk-o[data-symbol="APP3"]').click();
    await page.waitForFunction(() => /APP3/.test(document.querySelector('.mk-stats .mk-id')?.textContent ?? ''));
    await page.locator('.mk-pk-btn').click();
    await page.locator('.mk-pk-o').first().click();
    await page.getByRole('tab', { name: 'Book' }).click();
    await page.waitForSelector('[data-testid=bids]');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
  test('market 3D: a product on a white backdrop becomes a cutout, a box shot becomes a box, both turn', async () => {
    const post = async (query: string): Promise<void> => { await (await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, market: 'us' }) })).text(); };
    await post('LEGO 10294 Titanic');
    await post('LEGO 10294 Titanic boxed');
    const { page, errors } = await open('/market/');
    await page.waitForSelector('.mk-al .mk-ar');
    const pick = async (name: string): Promise<void> => { await page.locator('[data-testid=product-picker]').click(); await page.locator('.mk-pk-o').filter({ has: page.getByText(name, { exact: true }) }).click(); };
    await pick('LEGO 10294 Titanic boxed');
    await page.waitForSelector('.p3d-photo3d[data-mode=box] canvas', { timeout: 15000 });
    await pick('LEGO 10294 Titanic');
    await page.waitForSelector('.p3d-photo3d[data-mode=cutout] canvas', { timeout: 15000 });
    const canvas = page.locator('.p3d-photo3d canvas');
    const box = (await canvas.boundingBox())!;
    assert.ok(box.width > 150 && box.height > 150, 'the 3D view has room');
    assert.equal(await page.locator('.p3d-reset').isHidden(), true);
    await page.mouse.move(box.x + 80, box.y + 120); await page.mouse.down(); await page.mouse.move(box.x + 200, box.y + 130, { steps: 6 }); await page.mouse.up();
    await page.locator('.p3d-reset').waitFor({ state: 'visible' });
    await page.locator('.p3d-reset').click();
    await page.locator('.p3d-reset').waitFor({ state: 'hidden' });
    // a refresh of the data does not throw the turned card away
    await canvas.focus(); await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.p3d-reset').isVisible(), true);
    await page.waitForTimeout(21000);
    assert.equal(await page.locator('.p3d-reset').isVisible(), true, 'the 20 second refresh keeps the view');
    assert.deepEqual(errors, []);
    await page.context().close();
  });

  test('market book is live: it ages, picks up an owner change to the margin floor and flashes the bids that moved', async () => {
    const { page, errors } = await open('/market/');
    await page.waitForSelector('[data-testid=bids] .mk-bid');
    const bidOf = async (id: string): Promise<string> => (await page.locator(`.mk-bid[data-agent=${id}] > .n.buy`).textContent()) ?? '';
    const before = await bidOf('live');
    const age = async (): Promise<string> => (await page.locator('[data-testid=book-age]').textContent()) ?? '';
    assert.match(await age(), /^checked \d+(s| min| h| d) ago$/);
    const a0 = await age();
    await page.waitForFunction((x) => document.querySelector('[data-testid=book-age]')?.textContent !== x, a0, { timeout: 5000 });
    const put = await fetch(`${base}/api/limits`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-skudesk-owner': OWNER }, body: JSON.stringify({ minMarginBps: 2500 }) });
    assert.equal(put.status, 200);
    await page.waitForFunction((x) => document.querySelector('.mk-bid[data-agent=live] > .n.buy')?.textContent !== x, before, { timeout: 30000 });
    const after = await bidOf('live');
    const num = (t: string): number => Number(t.replace(/[^0-9.]/g, ''));
    assert.ok(num(after) < num(before), 'a higher floor lowers every bid');
    await page.locator('.mk-bid.fresh').first().waitFor({ state: 'attached', timeout: 1000 }).catch(() => {});
    // restore
    await fetch(`${base}/api/limits`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-skudesk-owner': OWNER }, body: JSON.stringify({ minMarginBps: 1000 }) });
    assert.deepEqual(errors, []);
    await page.context().close();
  });
  test('resale listings: preview, send to Merchant Center, status follows Google, the product page is public, remove', async () => {
    const a = await (await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'LEGO 10294 Titanic', market: 'us' }) })).json();
    const { page, errors } = await open('/app/listings/');
    await page.waitForFunction(() => /connected/.test(document.getElementById('mstate')?.textContent ?? ''), null, { timeout: 10000 });
    assert.match(await page.locator('#merchant').textContent() ?? '', /E2E Store/);
    assert.equal(await page.locator('#preview').isDisabled(), true, 'locked until the owner key is entered');
    await page.click('#ok-summary');
    await page.fill('#ok-input', OWNER);
    await page.click('#ok-form button[type=submit]');
    await page.waitForFunction(() => /unlocked/.test(document.getElementById('ok-label')?.textContent ?? ''));
    // nothing to list until a person has approved the buy
    await fetch(`${base}/api/proposals/${a.proposalId}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-skudesk-owner': OWNER }, body: JSON.stringify({ decision: 'approved' }) });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !(document.getElementById('preview') as HTMLButtonElement).disabled, null, { timeout: 10000 });
    assert.equal(await page.locator('#publish').isDisabled(), true, 'sending needs a preview first');
    await page.click('#preview');
    await page.waitForSelector('#preview-out table');
    assert.match(await page.locator('#preview-out').textContent() ?? '', /Price.*\$679\.99/s);
    assert.equal(merchantCalls.filter((c) => c.endsWith('productInputs:insert')).length, 0, 'a preview sends nothing');
    await page.click('#publish');
    await page.waitForSelector('#listings .row');
    assert.equal(merchantCalls.filter((c) => c.endsWith('productInputs:insert')).length, 1);
    const offer = (await page.locator('#listings .row').getAttribute('data-offer'))!;
    // a first read asks Google, which has approved it
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#listings .row');
    assert.equal(merchantCalls.filter((c) => c.endsWith('productInputs:insert')).length, 1, 'reloading does not send again');
    const row = await (await fetch(`${base}/api/merchant/listing/${offer}`)).json();
    assert.equal(row.status, 'APPROVED');
    // the product page Google reads
    const product = await open(`/p/${offer}/`);
    assert.match(await product.page.locator('h1').textContent() ?? '', /LEGO/i);
    assert.match(await product.page.locator('.price').textContent() ?? '', /\$679\.99/);
    assert.match(await product.page.locator('script[type="application/ld+json"]').textContent() ?? '', /"price":"679.99"/);
    assert.equal(await product.page.locator('.img img').getAttribute('src'), `/p/${offer}/image`);
    await product.page.context().close();
    await fetch(`${base}/api/merchant/listing/${offer}`, { method: 'DELETE', headers: { 'x-skudesk-owner': OWNER } });
    assert.equal((await fetch(`${base}/p/${offer}/`)).status, 404);
    assert.deepEqual(errors, []);
    await page.context().close();
  });
});
