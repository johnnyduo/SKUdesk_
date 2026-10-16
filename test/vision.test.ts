import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, type AgentDeps } from '../src/agent.ts';
import { MemoryStore } from '../src/store.ts';
import { buildVisionPrompt, createVisionEngine, parseVision, type VisionEngine } from '../src/vision.ts';
import type { IdentityResult, Listing } from '../src/identity.ts';
import type { AnalyzeEvent, Offer } from '../src/types.ts';

const offer = (seller: string, title: string, priceCents: number, thumbnail?: string): Offer => ({
  id: `${seller}-${priceCents}`, title, seller, channel: 'retailer', priceCents, currency: 'USD', shippingCents: 0, secondHand: false, url: `https://example.test/${seller}`, origin: 'serpapi', thumbnail,
});
const identical: IdentityResult = { verdict: 'identical', confidence: 0.98, reasons: [], mismatches: [] };
const engine = { compare: async (_a: Listing, _b: Listing) => identical };
const deps = (offers: Offer[], vision?: VisionEngine, over: Partial<AgentDeps> = {}): AgentDeps => ({ search: async () => ({ offers, fromCache: false }), engine, vision, store: new MemoryStore(), model: 't', now: () => new Date('2026-10-16T00:00:00Z'), ...over });

test('the prompt names the product, the title, and treats the picture text as untrusted', () => {
  const p = buildVisionPrompt('Apple iPhone 16 Pro 256GB', { title: 'iPhone 16 Pro case' });
  assert.match(p, /Apple iPhone 16 Pro 256GB/);
  assert.match(p, /iPhone 16 Pro case/);
  assert.match(p, /accessory/);
  assert.match(p, /untrusted/);
});

test('parseVision reads a verdict and refuses anything else', () => {
  const r = parseVision('```json\n{"seen":"a titanium phone in its box","verdict":"matches","reasons":["box shows 16 Pro"]}\n```');
  assert.equal(r.verdict, 'matches');
  assert.equal(r.seen, 'a titanium phone in its box');
  assert.throws(() => parseVision('{"verdict":"sure"}'));
  assert.throws(() => parseVision('not json'));
});

test('the engine sends the picture and the prompt, and gives no opinion without a picture or on an error', async () => {
  const sent: { prompt: string; mime: string; data: string }[] = [];
  const see = async (prompt: string, pic: { mime: string; data: string }) => { sent.push({ prompt, ...pic }); return JSON.stringify({ seen: 'a phone', verdict: 'matches', reasons: [] }); };
  const load = async () => ({ type: 'image/png', body: Buffer.from('PNGDATA') });
  const e = createVisionEngine(see, load);
  assert.equal((await e.check('q', offer('A', 't', 1, 'https://x/y.png')))?.verdict, 'matches');
  assert.equal(sent[0].mime, 'image/png');
  assert.equal(Buffer.from(sent[0].data, 'base64').toString(), 'PNGDATA');
  assert.equal(await e.check('q', offer('A', 't', 1)), null, 'no thumbnail, no opinion');
  assert.equal(await createVisionEngine(see, async () => null).check('q', offer('A', 't', 1, 'u')), null, 'unreadable picture, no opinion');
  assert.equal(await createVisionEngine(async () => { throw new Error('down'); }, load).check('q', offer('A', 't', 1, 'u')), null, 'a failed call gives no opinion');
  assert.equal(await createVisionEngine(async () => 'garbage', load).check('q', offer('A', 't', 1, 'u')), null, 'a garbled reply gives no opinion');
});

test('a photo that shows something else takes the match away; the rest still price', async () => {
  const vision: VisionEngine = { check: async (_q, o) => (o.seller === 'Case Co' ? { verdict: 'different', seen: 'a clear phone case, no phone', reasons: [] } : { verdict: 'matches', seen: 'the phone in its box', reasons: [] }) };
  const events: AnalyzeEvent[] = [];
  const a = await analyze({ query: 'Apple iPhone 16 Pro 256GB', market: 'us' }, deps([offer('Case Co', 'Apple iPhone 16 Pro 256GB', 3000, 'u1'), offer('Shop', 'Apple iPhone 16 Pro 256GB', 99900, 'u2'), offer('Shop2', 'Apple iPhone 16 Pro 256GB', 102900, 'u3')], vision), (e) => events.push(e));
  assert.equal(a.buy?.offer.seller, 'Shop', 'the $30 case photo no longer wins the cheapest spot');
  assert.equal(a.identical.length, 2);
  const dropped = a.rejected.find((g) => g.offer.seller === 'Case Co')!;
  assert.match(dropped.mismatches.join(' '), /photo: a clear phone case/);
  assert.equal(a.identical[0].visual?.verdict, 'matches');
  assert.equal(events.filter((e) => e.type === 'vision').length, 3);
  assert.match(a.notes.join(' '), /looked at 3 listing photos; 1 showed something other than the product and was dropped/);
});

test('without a vision engine, or without pictures, the text gate decides alone', async () => {
  const offers = [offer('A', 't', 10000, 'u'), offer('B', 't', 12000)];
  const none = await analyze({ query: 'q', market: 'us' }, deps(offers));
  assert.equal(none.identical.length, 2);
  assert.equal(none.identical[0].visual, undefined);
  const noPics = await analyze({ query: 'q', market: 'us' }, deps([offer('A', 't', 10000), offer('B', 't', 12000)], { check: async () => ({ verdict: 'different', seen: 'x', reasons: [] }) }));
  assert.equal(noPics.identical.length, 2, 'no thumbnails means nothing to look at');
});

test('the photo check only looks at listings the text already accepted, and its answers are cached', async () => {
  let calls = 0;
  const vision: VisionEngine = { check: async () => { calls++; return { verdict: 'matches', seen: 'ok', reasons: [] }; } };
  const reject = { compare: async (_a: Listing, b: Listing): Promise<IdentityResult> => ({ ...identical, verdict: /BAD/.test(b.title) ? 'different' : 'identical' }) };
  const d = deps([offer('A', 'good', 10000, 'u1'), offer('B', 'BAD one', 5000, 'u2')], vision, { engine: reject });
  const a = await analyze({ query: 'q', market: 'us' }, d);
  assert.equal(calls, 1, 'the rejected listing was never shown to the photo check');
  assert.equal(a.identical.length, 1);
  await analyze({ query: 'q', market: 'us' }, d);
  assert.equal(calls, 1, 'the same picture and query are not asked twice');
});

test('a photo that says unclear leaves the text verdict alone', async () => {
  const a = await analyze({ query: 'q', market: 'us' }, deps([offer('A', 't', 10000, 'u')], { check: async () => ({ verdict: 'unclear', seen: 'too small', reasons: [] }) }));
  assert.equal(a.identical.length, 1);
  assert.equal(a.identical[0].visual?.verdict, 'unclear');
});
