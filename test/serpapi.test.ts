import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseShipping, parseShopping, channelOf, searchShopping, MARKETS } from '../src/serpapi.ts';
import { MemoryStore, Quota, QuotaExceeded, cached } from '../src/store.ts';

// Real SerpApi response captured 2026-10-15, trimmed to the fields the adapter reads.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/serpapi-titanic-us.json', import.meta.url), 'utf8'));

test('parseShipping reads free, priced and unknown delivery text', () => {
  assert.equal(parseShipping('Free delivery'), 0);
  assert.equal(parseShipping('Free delivery by Wed'), 0);
  assert.equal(parseShipping('$5.99 delivery'), 599);
  assert.equal(parseShipping('+$12 shipping'), 1200);
  assert.equal(parseShipping('Free delivery on $49+'), 0);
  assert.equal(parseShipping(undefined), null);
  assert.equal(parseShipping('LEGO Resale Store'), null);
});

test('channelOf separates marketplaces from retailers', () => {
  assert.equal(channelOf('eBay - mtm155'), 'marketplace');
  assert.equal(channelOf('Mercari'), 'marketplace');
  assert.equal(channelOf('Walmart - StarGlow'), 'marketplace');
  assert.equal(channelOf('LEGO.com'), 'retailer');
  assert.equal(channelOf('Walmart'), 'retailer');
});

test('parseShopping turns the real fixture into integer-cent offers', () => {
  const offers = parseShopping(fixture, MARKETS.us);
  assert.equal(offers.length, fixture.shopping_results.length);
  const lego = offers.find((o) => o.seller === 'LEGO.com');
  assert.ok(lego);
  assert.equal(lego.priceCents, 67999);
  assert.equal(lego.shippingCents, 0);
  assert.equal(lego.channel, 'retailer');
  assert.equal(lego.currency, 'USD');
  assert.ok(offers.every((o) => Number.isInteger(o.priceCents) && o.priceCents > 0));
  assert.ok(offers.some((o) => o.secondHand));
});

test('parseShopping skips rows without a usable price', () => {
  assert.deepEqual(parseShopping({ shopping_results: [{ title: 'x' }, { title: 'y', extracted_price: 0 }] }, MARKETS.us), []);
  assert.deepEqual(parseShopping({}, MARKETS.us), []);
});

test('search is cached: the second call does not hit the network or the quota', async () => {
  const store = new MemoryStore();
  const quota = new Quota(store, 5);
  let calls = 0;
  const fetchStub = (async () => {
    calls++;
    return new Response(JSON.stringify(fixture), { status: 200 });
  }) as typeof fetch;
  const deps = { apiKey: 'k', store, quota, fetch: fetchStub };
  const first = await searchShopping('LEGO 10294 Titanic', MARKETS.us, deps);
  const second = await searchShopping('lego 10294 titanic ', MARKETS.us, deps);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(calls, 1);
  assert.equal(await quota.used(), 1);
  assert.equal(second.offers.length, first.offers.length);
});

test('fresh bypasses the cache', async () => {
  const store = new MemoryStore();
  const quota = new Quota(store, 5);
  let calls = 0;
  const fetchStub = (async () => (calls++, new Response(JSON.stringify(fixture), { status: 200 }))) as typeof fetch;
  const deps = { apiKey: 'k', store, quota, fetch: fetchStub };
  await searchShopping('a', MARKETS.us, deps);
  await searchShopping('a', MARKETS.us, deps, { fresh: true });
  assert.equal(calls, 2);
});

test('the quota cap blocks the search before any network call', async () => {
  const store = new MemoryStore();
  const quota = new Quota(store, 1);
  let calls = 0;
  const fetchStub = (async () => (calls++, new Response(JSON.stringify(fixture), { status: 200 }))) as typeof fetch;
  const deps = { apiKey: 'k', store, quota, fetch: fetchStub };
  await searchShopping('a', MARKETS.us, deps);
  await assert.rejects(searchShopping('b', MARKETS.us, deps), QuotaExceeded);
  assert.equal(calls, 1);
});

test('a SerpApi error is surfaced, not cached as an empty result', async () => {
  const store = new MemoryStore();
  const quota = new Quota(store, 5);
  const fetchStub = (async () => new Response(JSON.stringify({ error: 'Invalid API key.' }), { status: 200 })) as typeof fetch;
  await assert.rejects(searchShopping('a', MARKETS.us, { apiKey: 'k', store, quota, fetch: fetchStub }), /Invalid API key/);
});

test('cached() expires entries', async () => {
  const store = new MemoryStore();
  let t = 1000;
  let n = 0;
  const run = () => cached(store, 'k', 50, async () => ++n, { now: () => t });
  assert.equal((await run()).value, 1);
  assert.equal((await run()).hit, true);
  t += 100;
  const again = await run();
  assert.equal(again.hit, false);
  assert.equal(again.value, 2);
});
