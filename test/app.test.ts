import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp, impactOf } from '../src/app.ts';
import { MemoryStore, Quota } from '../src/store.ts';
import type { Analysis, Offer } from '../src/types.ts';
import type { IdentityResult } from '../src/identity.ts';

const offer = (seller: string, priceCents: number): Offer => ({
  id: `${seller}-${priceCents}`, title: 'LEGO SET', seller, channel: 'retailer', priceCents, currency: 'USD',
  shippingCents: 0, secondHand: false, url: 'https://example.test', origin: 'serpapi',
});
const identical: IdentityResult = { verdict: 'identical', confidence: 0.99, reasons: ['r'], mismatches: [], evidence: { brand: 'LEGO', brandQuoteA: 'LEGO', brandQuoteB: 'LEGO', idA: '1', idB: '1' } };

async function serve(over: Record<string, unknown> = {}) {
  const store = new MemoryStore();
  const app = createApp({
    store, quota: new Quota(store, 10), scanSecret: 's3cret', watchlist: [], sources: { serpapi: true, ebay: false }, storeKind: 'memory',
    agent: { search: async () => ({ offers: [offer('A', 10000), offer('B', 12000)], fromCache: false }), engine: { compare: async () => identical }, store, model: 'test' },
    ...over,
  });
  await new Promise<void>((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  return { base, store, close: () => app.close() };
}

test('serves the page, its assets and the health route', async () => {
  const s = await serve();
  assert.equal((await fetch(s.base + '/')).status, 200);
  assert.equal((await fetch(s.base + '/desk.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(s.base + '/fonts/inter.woff2')).headers.get('content-type'), 'font/woff2');
  assert.equal((await fetch(s.base + '/health')).status, 200);
  assert.equal((await fetch(s.base + '/../package.json')).status, 404);
  s.close();
});

test('the page ships a content security policy that allows no inline script', async () => {
  const s = await serve();
  const csp = (await fetch(s.base + '/')).headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  s.close();
});

test('streaming analyze emits progress events and ends with the analysis', async () => {
  const s = await serve();
  const res = await fetch(s.base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ query: 'LEGO SET 1', market: 'us' }) });
  assert.equal(res.status, 200);
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'search');
  assert.equal(types.filter((t) => t === 'gate').length, 2);
  assert.ok(types.includes('sanity') && types.includes('economics'));
  assert.equal(types.at(-1), 'done');
  assert.equal(events.at(-1).analysis.buy.offer.seller, 'A');
  s.close();
});

test('a malformed query is refused before any work is done', async () => {
  const s = await serve();
  const res = await fetch(s.base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '<script>', market: 'us' }) });
  assert.equal(res.status, 400);
  s.close();
});

test('the scan endpoint needs the secret', async () => {
  const s = await serve();
  assert.equal((await fetch(s.base + '/api/jobs/scan', { method: 'POST' })).status, 401);
  assert.equal((await fetch(s.base + '/api/jobs/scan', { method: 'POST', headers: { 'x-skudesk-secret': 'wrong' } })).status, 401);
  s.close();
});

test('approving a proposal is recorded once and cannot be flipped', async () => {
  const s = await serve();
  const a = await (await fetch(s.base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'LEGO SET 1', market: 'us' }) })).json();
  const url = `${s.base}/api/proposals/${a.proposalId}/decision`;
  const post = (decision: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
  assert.equal((await post('approved')).status, 200);
  assert.equal((await post('rejected')).status, 409);
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
