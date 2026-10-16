import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, impactOf } from '../src/app.ts';
import { MemoryStore, Quota } from '../src/store.ts';
import { getLimits } from '../src/domain.ts';
import type { Analysis, Offer } from '../src/types.ts';
import type { IdentityResult } from '../src/identity.ts';

const offer = (seller: string, priceCents: number): Offer => ({
  id: `${seller}-${priceCents}`, title: 'LEGO SET', seller, channel: 'retailer', priceCents, currency: 'USD',
  shippingCents: 0, secondHand: false, url: 'https://example.test', origin: 'serpapi',
});
const identical: IdentityResult = { verdict: 'identical', confidence: 0.99, reasons: ['r'], mismatches: [], evidence: { brand: 'LEGO', brandQuoteA: 'LEGO', brandQuoteB: 'LEGO', idA: '1', idB: '1' } };

const siteDir = mkdtempSync(join(tmpdir(), 'skudesk-site-'));
mkdirSync(join(siteDir, '_astro'));
mkdirSync(join(siteDir, 'app'));
writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>SKUdesk</title>');
writeFileSync(join(siteDir, 'app', 'index.html'), '<!doctype html><title>Desk</title>');
writeFileSync(join(siteDir, '404.html'), '<!doctype html><title>Missing</title>');
writeFileSync(join(siteDir, '_astro', 'x.abc123.js'), 'export {}');

async function serve(over: Record<string, unknown> = {}) {
  const store = new MemoryStore();
  const app = createApp({
    store, quota: new Quota(store, 10), scanSecret: 's3cret', ownerKey: 'owner-key', edgeSecret: 'edge-secret', watchlist: [], sources: { serpapi: true, ebay: false }, storeKind: 'memory', siteDir,
    agent: { search: async () => ({ offers: [offer('A', 10000), offer('B', 12000)], fromCache: false }), engine: { compare: async () => identical }, store, model: 'hidden-model-name', limits: () => getLimits(store) },
    ...over,
  });
  await new Promise<void>((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, store, post, close: () => app.close() };
}
const OWNER = { 'x-skudesk-owner': 'owner-key' };

test('serves pages, clean-URL redirects, hashed assets and a 404 page', async () => {
  const s = await serve();
  assert.equal((await fetch(s.base + '/')).status, 200);
  assert.equal((await fetch(s.base + '/app/')).status, 200);
  const redirect = await fetch(s.base + '/app', { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/app/');
  assert.match((await fetch(s.base + '/_astro/x.abc123.js')).headers.get('cache-control') ?? '', /immutable/);
  const missing = await fetch(s.base + '/nope');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Missing/);
  assert.equal((await fetch(s.base + '/../package.json')).status, 404);
  s.close();
});

test('pages revalidate with an ETag so a deploy can never be pinned by a stale copy', async () => {
  const s = await serve();
  const first = await fetch(s.base + '/');
  const etag = first.headers.get('etag')!;
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(s.base + '/', { headers: { 'if-none-match': etag } })).status, 304);
  s.close();
});

test('every response carries the security headers and a strict script policy', async () => {
  const s = await serve();
  for (const path of ['/', '/health', '/api/impact']) {
    const h = (await fetch(s.base + path)).headers;
    assert.match(h.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.doesNotMatch(h.get('content-security-policy') ?? '', /script-src[^;]*unsafe/);
    assert.match(h.get('strict-transport-security') ?? '', /max-age=/);
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.equal(h.get('x-content-type-options'), 'nosniff');
  }
  s.close();
});

test('the model name never reaches a response', async () => {
  const s = await serve({ evalSummary: { model: 'hidden-model-name', pairs: 43, falseIdentical: 0 } });
  const a = await (await s.post('/api/analyze', { query: 'LEGO SET 1', market: 'us' })).json();
  const bodies = [JSON.stringify(a), await (await fetch(s.base + '/api/status')).text(), await (await fetch(s.base + '/api/eval')).text(), await (await fetch(s.base + `/api/analyses/${a.id}`)).text()];
  for (const b of bodies) assert.doesNotMatch(b, /hidden-model-name/);
  assert.equal((await (await fetch(s.base + '/api/eval')).json()).pairs, 43);
  s.close();
});

test('streaming analyze emits progress events and ends with the analysis', async () => {
  const s = await serve();
  const res = await fetch(s.base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ query: 'LEGO SET 1', market: 'us' }) });
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'search');
  assert.equal(types.filter((t) => t === 'gate').length, 2);
  assert.equal(types.at(-1), 'done');
  assert.equal(events.at(-1).analysis.buy.offer.seller, 'A');
  s.close();
});

test('a malformed query is refused before any work is done', async () => {
  const s = await serve();
  assert.equal((await s.post('/api/analyze', { query: '<script>', market: 'us' })).status, 400);
  s.close();
});

test('analyze is rate limited per caller and the limit cannot be dodged with a forged forwarded-for', async () => {
  const s = await serve({ analyzePerMin: 2 });
  const hit = (ff: string) => s.post('/api/analyze', { query: 'LEGO SET 1', market: 'us' }, { 'x-forwarded-for': ff });
  assert.equal((await hit('1.1.1.1, 9.9.9.9')).status, 200);
  assert.equal((await hit('2.2.2.2, 9.9.9.9')).status, 200);
  assert.equal((await hit('3.3.3.3, 9.9.9.9')).status, 429);
  s.close();
});

test('the edge address is trusted only with the shared secret', async () => {
  const s = await serve({ analyzePerMin: 1 });
  const viaEdge = (ip: string, secret: string) => s.post('/api/analyze', { query: 'LEGO SET 1', market: 'us' }, { 'x-skudesk-edge': secret, 'x-skudesk-client-ip': ip, 'x-forwarded-for': '9.9.9.9' });
  assert.equal((await viaEdge('1.1.1.1', 'edge-secret')).status, 200);
  assert.equal((await viaEdge('2.2.2.2', 'edge-secret')).status, 200);
  // with a wrong secret the forged header is ignored and the real peer address is used, so it is limited like anyone else
  assert.equal((await viaEdge('3.3.3.3', 'wrong')).status, 200);
  assert.equal((await viaEdge('4.4.4.4', 'wrong')).status, 429);
  s.close();
});

test('a decision needs the requester token or the owner key', async () => {
  const s = await serve();
  const a = await (await s.post('/api/analyze', { query: 'LEGO SET 1', market: 'us' })).json();
  const url = `/api/proposals/${a.proposalId}/decision`;
  assert.equal((await s.post(url, { decision: 'approved' })).status, 403);
  assert.equal((await s.post(url, { decision: 'approved', token: 'x'.repeat(48) })).status, 403);
  assert.equal((await s.post(url, { decision: 'approved', token: a.decisionToken })).status, 200);
  assert.equal((await s.post(url, { decision: 'rejected', token: a.decisionToken })).status, 409);
  s.close();
});

test('the proposal list never exposes token hashes', async () => {
  const s = await serve();
  await s.post('/api/analyze', { query: 'LEGO SET 1', market: 'us' });
  const list = await (await fetch(s.base + '/api/proposals')).text();
  assert.doesNotMatch(list, /tokenHash/);
  s.close();
});

test('owner endpoints refuse everyone without the key', async () => {
  const s = await serve();
  assert.equal((await fetch(s.base + '/api/owner/check')).status, 401);
  assert.equal((await fetch(s.base + '/api/owner/check', { headers: OWNER })).status, 200);
  const put = (headers: Record<string, string>) => fetch(s.base + '/api/limits', { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ maxSpendCents: 5000 }) });
  assert.equal((await put({})).status, 401);
  assert.equal((await put({ 'x-skudesk-owner': 'guess' })).status, 401);
  assert.equal((await put(OWNER)).status, 200);
  assert.equal((await (await fetch(s.base + '/api/limits')).json()).maxSpendCents, 5000);
  assert.equal((await s.post('/api/watches', { query: 'LEGO 1234', market: 'us' })).status, 401);
  s.close();
});

test('limits are validated', async () => {
  const s = await serve();
  const put = (body: unknown) => fetch(s.base + '/api/limits', { method: 'PUT', headers: { 'content-type': 'application/json', ...OWNER }, body: JSON.stringify(body) });
  assert.equal((await put({ maxSpendCents: -5 })).status, 400);
  assert.equal((await put({ minMarginBps: 1.5 })).status, 400);
  assert.equal((await put({ paused: 'yes' })).status, 400);
  s.close();
});

test('the kill switch stops scans, new proposals and decisions', async () => {
  const s = await serve();
  const a = await (await s.post('/api/analyze', { query: 'LEGO SET 1', market: 'us' })).json();
  await fetch(s.base + '/api/limits', { method: 'PUT', headers: { 'content-type': 'application/json', ...OWNER }, body: JSON.stringify({ paused: true }) });
  assert.equal((await s.post(`/api/proposals/${a.proposalId}/decision`, { decision: 'approved', token: a.decisionToken })).status, 423);
  assert.equal((await s.post('/api/jobs/scan', {}, { 'x-skudesk-secret': 's3cret' })).status, 423);
  const b = await (await s.post('/api/analyze', { query: 'LEGO SET 2', market: 'us' })).json();
  assert.equal(b.proposalId, null);
  s.close();
});

test('watches: owner adds and removes, scans use them', async () => {
  const s = await serve();
  const added = await s.post('/api/watches', { query: 'LEGO 10294 Titanic', market: 'us' }, OWNER);
  assert.equal(added.status, 201);
  const w = await added.json();
  assert.equal((await s.post('/api/watches', { query: 'LEGO 10294 Titanic', market: 'us' }, OWNER)).status, 409);
  const scan = await (await s.post('/api/jobs/scan', {}, { 'x-skudesk-secret': 's3cret' })).json();
  assert.equal(scan.done.length, 1);
  assert.equal((await fetch(s.base + `/api/watches/${w.id}`, { method: 'DELETE', headers: OWNER })).status, 200);
  assert.deepEqual(await (await fetch(s.base + '/api/watches')).json(), []);
  s.close();
});

test('the scan endpoint needs the secret or the owner key', async () => {
  const s = await serve();
  assert.equal((await s.post('/api/jobs/scan', {})).status, 401);
  assert.equal((await s.post('/api/jobs/scan', {}, { 'x-skudesk-secret': 'wrong' })).status, 401);
  assert.equal((await s.post('/api/jobs/scan', {}, OWNER)).status, 200);
  s.close();
});

test('the image proxy only fetches allow-listed hosts', async () => {
  const s = await serve();
  for (const u of ['https://evil.example/a.png', 'http://encrypted-tbn0.gstatic.com/a.png', 'https://encrypted-tbn0.gstatic.com:8443/a.png', 'file:///etc/passwd', 'not a url']) {
    assert.equal((await fetch(s.base + `/api/img?u=${encodeURIComponent(u)}`)).status, 400, u);
  }
  s.close();
});

test('what-if returns the economics and checks the spend limit', async () => {
  const s = await serve();
  const r = await (await s.post('/api/whatif', { buyCents: 20000, shippingCents: 0, sellCents: 32000 })).json();
  assert.equal(r.verdict, 'profitable');
  assert.equal(r.netCents, 5700);
  assert.equal(r.withinSpendLimit, true);
  assert.equal((await s.post('/api/whatif', { buyCents: -1, shippingCents: 0, sellCents: 5 })).status, 400);
  s.close();
});

test('products and lots expose the latest check with its history', async () => {
  const s = await serve();
  await s.post('/api/analyze', { query: 'LEGO SET 1', market: 'us' });
  const products = await (await fetch(s.base + '/api/products')).json();
  assert.equal(products.length, 1);
  assert.equal(products[0].series.length, 1);
  const lot = await (await fetch(s.base + `/api/lots/${products[0].key}`)).json();
  assert.equal(lot.analysis.query, 'LEGO SET 1');
  s.close();
});

test('impact counts the latest check per product and only believable-price gaps', () => {
  const base = { market: 'us', currency: 'USD' } as Analysis;
  const a = (query: string, at: string, considered: number, ident: number, different: number, uncertain: number, flagged: Analysis['flagged']): Analysis =>
    ({ ...base, query, createdAt: at, gate: { considered, identical: ident, different, uncertain }, flagged } as Analysis);
  const flag = { referenceCents: 10000, offer: { priceCents: 1000 } } as Analysis['flagged'][number];
  const out = impactOf([
    a('LEGO A', '2026-10-01T00:00:00Z', 30, 5, 20, 5, []),
    a('LEGO A', '2026-10-02T00:00:00Z', 30, 7, 19, 4, [flag]),
    a('LEGO B', '2026-10-02T00:00:00Z', 10, 0, 10, 0, []),
  ]);
  assert.deepEqual(out, { products: 2, listings: 40, passed: 7, rejected: 33, flagged: 1, phantomCents: 9000 });
});

test('the owner can take a product off the desk; its checks, history and pending proposals go', async () => {
  const s = await serve();
  const a = await (await s.post('/api/analyze', { query: 'LEGO SET 1', market: 'us' })).json();
  const key = (await (await fetch(s.base + '/api/products')).json())[0].key;
  const gone = (headers: Record<string, string> = {}) => fetch(`${s.base}/api/products/${key}`, { method: 'DELETE', headers });
  assert.equal((await gone()).status, 401);
  const r = await (await gone(OWNER)).json();
  assert.equal(r.removed, key);
  assert.equal(r.checks, 1);
  assert.equal(r.proposals, 1);
  assert.deepEqual(await (await fetch(s.base + '/api/products')).json(), []);
  assert.equal((await fetch(`${s.base}/api/proposals`)).status, 200);
  assert.equal((await (await fetch(`${s.base}/api/proposals`)).json()).length, 0);
  assert.equal((await gone(OWNER)).status, 404);
  void a;
  s.close();
});

test('the owner can remove one check; its pending proposal and its price point go with it', async () => {
  const s = await serve();
  const a = await (await s.post('/api/analyze', { query: 'LEGO SET 1', market: 'us' })).json();
  const del = (headers: Record<string, string> = {}) => fetch(`${s.base}/api/analyses/${a.id}`, { method: 'DELETE', headers });
  assert.equal((await del()).status, 401);
  assert.equal((await fetch(`${s.base}/api/products`).then((r) => r.json()))[0].series.length, 1);
  const r = await (await del(OWNER)).json();
  assert.equal(r.removed, a.id);
  assert.equal(r.proposals, 1);
  assert.equal((await fetch(`${s.base}/api/analyses/${a.id}`)).status, 404);
  assert.deepEqual(await (await fetch(`${s.base}/api/products`)).json(), []);
  assert.equal((await (await fetch(`${s.base}/api/proposals`)).json()).length, 0);
  assert.equal((await del(OWNER)).status, 404);
  s.close();
});

test('a long watchlist is scanned in turn: the watches that waited longest go first', async () => {
  const searched: string[] = [];
  const store = new MemoryStore();
  const app = createApp({
    store, quota: new Quota(store, 20), scanSecret: 's3cret', ownerKey: 'owner-key', watchlist: [], scanMax: 2, sources: { serpapi: true, ebay: false }, storeKind: 'memory', siteDir,
    agent: { search: async (q: string) => { searched.push(q); return { offers: [offer('A', 10000), offer('B', 12000)], fromCache: false }; }, engine: { compare: async () => identical }, store, model: 'm', limits: () => getLimits(store) },
  });
  await new Promise<void>((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const add = (query: string) => fetch(`${base}/api/watches`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-skudesk-owner': 'owner-key' }, body: JSON.stringify({ query, market: 'us' }) });
  for (const q of ['Phone One 128GB', 'Phone Two 128GB', 'Phone Three 128GB', 'Phone Four 128GB']) await add(q);
  const scan = () => fetch(`${base}/api/jobs/scan`, { method: 'POST', headers: { 'x-skudesk-secret': 's3cret' } });
  await scan();
  assert.deepEqual(searched.splice(0), ['Phone One 128GB', 'Phone Two 128GB']);
  await new Promise((r) => setTimeout(r, 5));
  await scan();
  assert.deepEqual(searched.splice(0), ['Phone Three 128GB', 'Phone Four 128GB']);
  await new Promise((r) => setTimeout(r, 5));
  await scan();
  assert.deepEqual(searched.splice(0), ['Phone One 128GB', 'Phone Two 128GB'], 'the third scan starts the list again');
  app.close();
});

test('prices recorded under older identity checks are not compared with current ones', async () => {
  const { comparable } = await import('../src/domain.ts');
  const { IDENTITY_VERSION } = await import('../src/identity.ts');
  const pt = (t: string, v: number | undefined, cents: number) => ({ t, v, buyLandedCents: cents, lowestAskCents: null, identical: 1, considered: 5 });
  const mixed = [pt('a', undefined, 114898), pt('b', IDENTITY_VERSION - 1, 100000), pt('c', IDENTITY_VERSION, 31497), pt('d', IDENTITY_VERSION, 31497)];
  assert.deepEqual(comparable(mixed).map((p) => p.t), ['c', 'd']);
  assert.deepEqual(comparable(mixed.slice(0, 2)).map((p) => p.t), ['a', 'b'], 'with nothing current, the old points are all there is');
  assert.deepEqual(comparable([]), []);
});
