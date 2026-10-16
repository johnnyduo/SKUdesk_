import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, type AgentDeps } from '../src/agent.ts';
import { MemoryStore } from '../src/store.ts';
import { DEFAULT_LIMITS } from '../src/domain.ts';
import type { IdentityResult, Listing } from '../src/identity.ts';
import type { Analysis, Offer, Proposal } from '../src/types.ts';

const offer = (seller: string, title: string, priceCents: number, over: Partial<Offer> = {}): Offer => ({
  id: `${seller}-${priceCents}`, title, seller, channel: seller.startsWith('eBay') || seller === 'Mercari' ? 'marketplace' : 'retailer',
  priceCents, currency: 'USD', shippingCents: 0, secondHand: false, url: `https://example.test/${seller}`, origin: 'serpapi', ...over,
});

// The fake engine says "identical" only for titles containing the marker SET. It stands in for Gemini in logic tests only.
const verdict = (v: IdentityResult['verdict'], c = 0.98): IdentityResult => ({ verdict: v, confidence: c, reasons: ['r'], mismatches: [] });
const fakeEngine = { compare: async (_a: Listing, b: Listing) => verdict(/SET/.test(b.title) ? 'identical' : 'different') };

function deps(offers: Offer[], over: Partial<AgentDeps> = {}): AgentDeps {
  return { search: async () => ({ offers, fromCache: false }), engine: fakeEngine, store: new MemoryStore(), model: 'test', now: () => new Date('2026-10-16T00:00:00Z'), ...over };
}

test('only offers that clear the gate are priced; the rest are listed as rejected', async () => {
  const a = await analyze({ query: 'LEGO SET', market: 'us' }, deps([
    offer('LEGO.com', 'LEGO SET sealed', 10000),
    offer('eBay - x', 'light kit for the set', 2000),
  ]));
  assert.equal(a.identical.length, 1);
  assert.equal(a.rejected.length, 1);
  assert.equal(a.buy?.offer.seller, 'LEGO.com');
  assert.equal(a.gate.different, 1);
});

test('the cheapest landed cost wins, shipping included', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([
    offer('A', 'SET', 9000, { shippingCents: 2500 }),
    offer('B', 'SET', 10000, { shippingCents: 0 }),
  ]));
  assert.equal(a.buy?.offer.seller, 'B');
  assert.equal(a.buy?.landedCents, 10000);
});

test('unknown shipping uses the assumption and is flagged', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([offer('A', 'SET', 9000, { shippingCents: null })]));
  assert.equal(a.buy?.shippingAssumed, true);
  assert.equal(a.buy?.landedCents, 9000 + 1000);
  assert.ok(a.notes.some((n) => /did not state shipping/.test(n)));
});

test('nothing identical means an honest "no" and no proposal', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([offer('A', 'light kit', 500)]));
  assert.equal(a.buy, null);
  assert.equal(a.arbitrage, null);
  assert.equal(a.proposalId, null);
  assert.match(a.headline, /No identical sealed product found/);
});

test('arbitrage that loses after costs says no arbitrage', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([
    offer('LEGO.com', 'SET', 68000),
    offer('Mercari', 'SET', 63500),
    offer('eBay - y', 'SET', 70000),
  ]));
  assert.equal(a.buy?.offer.seller, 'Mercari');
  assert.equal(a.arbitrage?.verdict, 'loss');
  assert.match(a.headline, /No arbitrage/);
});

test('arbitrage that clears every cost is reported with its net', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([
    offer('Store', 'SET', 20000),
    offer('eBay - z', 'SET', 32000),
  ]));
  assert.equal(a.arbitrage?.verdict, 'profitable');
  // 32000 - 13% fee (4160) - 2% reserve (640) - 1500 shipping - 20000 landed = 5700
  assert.equal(a.arbitrage?.netCents, 5700);
});

test('a margin under the floor is thin, not profitable', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([
    offer('Store', 'SET', 25000),
    offer('eBay - z', 'SET', 33000),
  ]));
  // 33000 - 4290 - 660 - 1500 - 25000 = 1550, which is 6.2% of landed cost: positive but under the 10% floor
  assert.equal(a.arbitrage?.netCents, 1550);
  assert.equal(a.arbitrage?.verdict, 'thin');
});

test('a buy files a pending proposal and never anything else', async () => {
  const d = deps([offer('LEGO.com', 'SET', 10000)]);
  const a = await analyze({ query: 'q', market: 'us' }, d);
  const p = await d.store.get<Proposal>('proposals', a.proposalId!);
  assert.equal(p?.status, 'pending');
  assert.equal(p?.landedCents, 10000);
});

test('each analysis files its own proposal; a decided one stays decided', async () => {
  const d = deps([offer('LEGO.com', 'SET', 10000)]);
  let n = 0;
  d.now = () => new Date(Date.UTC(2026, 9, 16, 0, 0, ++n));
  const first = await analyze({ query: 'q', market: 'us' }, d);
  const p = (await d.store.get<Proposal>('proposals', first.proposalId!))!;
  await d.store.set('proposals', p.id, { ...p, status: 'approved' });
  const second = await analyze({ query: 'q', market: 'us' }, d);
  assert.notEqual(second.proposalId, first.proposalId);
  assert.equal((await d.store.get<Proposal>('proposals', p.id))?.status, 'approved');
});

test('the requester gets a decision token and only its hash is stored', async () => {
  const d = deps([offer('LEGO.com', 'SET', 10000)]);
  const a = await analyze({ query: 'q', market: 'us' }, d);
  assert.match(a.decisionToken ?? '', /^[0-9a-f]{48}$/);
  const p = (await d.store.get<Proposal>('proposals', a.proposalId!))!;
  assert.ok(p.tokenHash && p.tokenHash !== a.decisionToken);
  const stored = await d.store.get<Analysis>('analyses', a.id);
  assert.equal(stored?.decisionToken, undefined);
});

test('a scheduled scan files a proposal without any token', async () => {
  const d = deps([offer('LEGO.com', 'SET', 10000)]);
  const a = await analyze({ query: 'q', market: 'us', system: true }, d);
  assert.equal(a.decisionToken, undefined);
  assert.equal((await d.store.get<Proposal>('proposals', a.proposalId!))?.origin, 'scan');
});

test('a paused agent files no proposal', async () => {
  const d = deps([offer('LEGO.com', 'SET', 10000)], { limits: async () => ({ ...DEFAULT_LIMITS, paused: true }) });
  const a = await analyze({ query: 'q', market: 'us' }, d);
  assert.equal(a.proposalId, null);
  assert.ok(a.notes.some((n) => /paused/.test(n)));
});

test('a buy above the per-buy limit is filed as blocked', async () => {
  const d = deps([offer('LEGO.com', 'SET', 50000)], { limits: async () => ({ ...DEFAULT_LIMITS, maxSpendCents: 20000 }) });
  const a = await analyze({ query: 'q', market: 'us' }, d);
  const p = (await d.store.get<Proposal>('proposals', a.proposalId!))!;
  assert.match(p.blockedReason ?? '', /per-buy limit/);
});

test('the margin floor comes from the owner limits', async () => {
  const d = deps([offer('Store', 'SET', 25000), offer('eBay - z', 'SET', 33000)], { limits: async () => ({ ...DEFAULT_LIMITS, minMarginBps: 500 }) });
  const a = await analyze({ query: 'q', market: 'us' }, d);
  assert.equal(a.arbitrage?.verdict, 'profitable');
});

test('the public analysis never names the model', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([offer('A', 'SET', 100)], { model: 'secret-model-name' }));
  assert.equal(a.model, 'Gemini');
});

test('identity verdicts are cached across analyses', async () => {
  let calls = 0;
  const d = deps([offer('A', 'SET', 100)], { engine: { compare: async () => (calls++, verdict('identical')) } });
  await analyze({ query: 'q', market: 'us' }, d);
  await analyze({ query: 'q', market: 'us' }, d);
  assert.equal(calls, 1);
});

test('engine errors are not cached and never pass the gate', async () => {
  let calls = 0;
  const failing = { compare: async (): Promise<IdentityResult> => (calls++, { verdict: 'uncertain', confidence: 0, reasons: [], mismatches: ['engine error: 503'] }) };
  const d = deps([offer('A', 'SET', 100)], { engine: failing });
  const a = await analyze({ query: 'q', market: 'us' }, d);
  await analyze({ query: 'q', market: 'us' }, d);
  assert.equal(a.buy, null);
  assert.equal(calls, 2);
});

test('an identical verdict below the confidence floor is demoted to uncertain', async () => {
  const d = deps([offer('A', 'SET', 100)], { engine: { compare: async () => verdict('identical', 0.6) } });
  const a = await analyze({ query: 'q', market: 'us' }, d);
  assert.equal(a.buy, null);
  assert.equal(a.gate.uncertain, 1);
});

test('duplicate listings are collapsed', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([offer('A', 'SET', 100), offer('A', 'SET', 100)]));
  assert.equal(a.gate.considered, 1);
});

test('an unknown market is rejected', async () => {
  await assert.rejects(analyze({ query: 'q', market: 'zz' }, deps([])), /unknown market/);
});

test('a price far below the identical median is flagged and never traded on', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([
    offer('Bait', 'SET', 1100),
    offer('A', 'SET', 63500),
    offer('B', 'SET', 67999),
    offer('C', 'SET', 94500),
  ]));
  assert.equal(a.flagged.length, 1);
  assert.equal(a.flagged[0].offer.seller, 'Bait');
  assert.equal(a.buy?.offer.seller, 'A');
  assert.equal(a.gate.identical, 4);
  assert.ok(a.notes.some((n) => /data errors/.test(n)));
});

test('with fewer than three identical offers there is no median to judge by', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([offer('A', 'SET', 100), offer('B', 'SET', 100000)]));
  assert.equal(a.flagged.length, 0);
});

test('resale is capped by the next cheapest identical price, retailer or marketplace', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([
    offer('Mercari', 'SET', 63500),
    offer('LEGO.com', 'SET', 67999),
    offer('Mercari', 'SET', 94500, { id: 'm2' }),
  ]));
  assert.equal(a.arbitrage?.sellReference.seller, 'LEGO.com');
  assert.equal(a.arbitrage?.verdict, 'loss');
  assert.equal(a.sell?.referenceOffer.priceCents, 63500);
});

test('a price under half the recalled retail price is flagged even with few offers', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([offer('Bait', 'SET', 9200), offer('LEGO.com', 'SET', 67999)], { retail: async () => 67999 }));
  assert.equal(a.flagged.length, 1);
  assert.equal(a.flagged[0].reason, 'retail');
  assert.equal(a.buy?.offer.seller, 'LEGO.com');
  assert.ok(a.notes.some((n) => /recalls a typical retail price/.test(n)));
});

test('an unknown retail price changes nothing', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([offer('A', 'SET', 100), offer('B', 'SET', 60000)], { retail: async () => null }));
  assert.equal(a.flagged.length, 0);
});

test('a margin above 50% is called too good to be true, not arbitrage', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([offer('Cheap', 'SET', 36000), offer('Retail', 'SET', 85000)]));
  assert.equal(a.arbitrage?.verdict, 'profitable');
  assert.equal(a.arbitrage?.implausible, true);
  assert.match(a.headline, /Too good to be true/);
});

test('when the Identity Engine fails for many listings the result is flagged as not a verdict', async () => {
  const failing = { compare: async (): Promise<IdentityResult> => ({ verdict: 'uncertain', confidence: 0, reasons: [], mismatches: ['engine error: 503'] }) };
  const d = deps([offer('A', 'SET', 100), offer('B', 'SET', 200)], { engine: failing });
  const a = await analyze({ query: 'q', market: 'us' }, d);
  assert.equal(a.degraded, true);
  assert.match(a.headline, /not a verdict/);
  assert.equal(a.proposalId, null);
});

test('a few engine errors are noted but do not void the check', async () => {
  let n = 0;
  const flaky = { compare: async (): Promise<IdentityResult> => (++n === 1 ? { verdict: 'uncertain', confidence: 0, reasons: [], mismatches: ['engine error: 503'] } : verdict('identical')) };
  const offers = ['A', 'B', 'C', 'D'].map((s, i) => offer(s, 'SET', 10000 + i * 1000));
  const a = await analyze({ query: 'q', market: 'us' }, deps(offers, { engine: flaky, concurrency: 1 }));
  assert.equal(a.degraded, undefined);
  assert.ok(a.notes.some((x) => /could not be judged/.test(x)));
});

test('shipping defaults scale with the market so they stay realistic in a high-denomination currency', async () => {
  const a = await analyze({ query: 'q', market: 'th' }, deps([offer('A', 'SET', 300000, { shippingCents: null })]));
  assert.equal(a.assumptions.unknownShippingCents, 35000);
  assert.equal(a.assumptions.outboundShippingCents, 52500);
});

test('listings the source labels pre-owned never reach the gate, and the slots go to new ones', async () => {
  let judged = 0;
  const counting = { compare: async (_a: Listing, b: Listing) => { judged++; return verdict(/SET/.test(b.title) ? 'identical' : 'different'); } };
  const a = await analyze({ query: 'SET', market: 'us' }, deps([
    offer('A', 'SET new', 10000),
    offer('B', 'SET renewed', 5000, { secondHand: true }),
    offer('C', 'SET refurbished', 6000, { secondHand: true }),
  ], { engine: counting }));
  assert.equal(judged, 1);
  assert.equal(a.buy?.offer.seller, 'A');
  assert.match(a.notes.join(' '), /2 listings were left out because the source labels them pre-owned or refurbished/);
});
