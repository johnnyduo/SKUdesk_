import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, profileFor, bookAt, activeGap, anchorOf, roundOf, seriesOf, AGENT_RULES, ROUND_MS, FEE_BPS, type Profile } from '../web/src/lib/practice.ts';

const NOW = Date.UTC(2026, 9, 16, 9, 30, 0);
const phone = (): Profile => profileFor({ key: 'S26', symbol: 'S26', name: 'Galaxy S26', currency: 'USD', fairCents: 93000, retailCents: 99999, category: 'Phones' });
const sets = (): Profile => profileFor({ key: 'abc123', symbol: '10294', name: 'LEGO Titanic 10294', currency: 'USD', fairCents: 64000, retailCents: 67999, offers: 6 });
const caseP = (): Profile => profileFor({ key: 'IP16P-CLR', symbol: 'IP16P-CLR', name: 'iPhone 16 Pro Clear Case', currency: 'USD', fairCents: 4500, retailCents: 4900, category: 'Accessories' });

test('the same product at the same moment gives the same history, book and trades', () => {
  const a = createEngine(phone(), NOW), b = createEngine(phone(), NOW);
  assert.equal(a.rounds.length, b.rounds.length);
  assert.deepEqual(a.rounds.slice(-50), b.rounds.slice(-50));
  assert.deepEqual(a.log, b.log);
  assert.deepEqual(a.agents.map((x) => [x.cash, x.realized, x.lots.length]), b.agents.map((x) => [x.cash, x.realized, x.lots.length]));
});

test('advancing round by round matches building the engine later', () => {
  const live = createEngine(phone(), NOW);
  live.advanceTo(roundOf(NOW) + 300);
  const fresh = createEngine(phone(), NOW + 300 * ROUND_MS);
  assert.equal(live.rounds.length, fresh.rounds.length);
  assert.deepEqual(live.rounds.slice(-40).map((r) => r.ask), fresh.rounds.slice(-40).map((r) => r.ask));
  assert.deepEqual(live.log.map((l) => l.text), fresh.log.map((l) => l.text));
});

test('history starts at a fixed anchor, the same for everyone that day', () => {
  const e = createEngine(phone(), NOW);
  assert.equal(e.anchor, anchorOf(roundOf(NOW)));
  assert.equal(e.rounds[0].n, e.anchor);
  assert.equal(e.rounds.at(-1)!.n, roundOf(NOW));
});

test('prices stay positive, whole cents, and near the fair value', () => {
  for (const p of [phone(), sets(), caseP()]) {
    const e = createEngine(p, NOW);
    const asks = e.rounds.map((r) => r.ask).filter((x): x is number => x !== null);
    assert.ok(asks.length > e.rounds.length * 0.99, 'a book almost always has an identical offer');
    assert.ok(asks.every((x) => Number.isInteger(x) && x > 0));
    assert.ok(Math.min(...asks) > p.fairCents * 0.55 && Math.max(...asks) < p.fairCents * 1.12, `${p.symbol} stays in a believable band`);
  }
});

test('products behave differently: moves, sellers and gaps are not the same', () => {
  const ps = [phone(), sets(), caseP()];
  const move = ps.map((p) => {
    const e = createEngine(p, NOW);
    const ys = e.rounds.slice(-600).map((r) => r.ask!);
    const rets = ys.slice(1).map((y, i) => Math.abs(Math.log(y / ys[i])));
    return rets.reduce((s, x) => s + x, 0) / rets.length;
  });
  assert.ok(new Set(move.map((m) => m.toFixed(5))).size === 3);
  assert.ok(move[2] > move[0], 'a cheap crowded accessory moves more than a steady phone');
  assert.notEqual(ps[0].sellers.length, ps[1].sellers.length);
  assert.notEqual(ps[0].sellers.map((s) => s.name).join(), ps[2].sellers.map((s) => s.name).join());
});

test('a bait price is set aside by the gate and never bought', () => {
  let found = 0;
  for (const p of [phone(), sets(), caseP()]) {
    const e = createEngine(p, NOW + 3 * 86_400_000);
    for (const r of e.rounds) {
      const g = activeGap(p, r.n);
      if (g?.cls !== 'bait') continue;
      const book = bookAt(p, r.n, r.mid);
      const dip = book.offers.find((o) => o.dip)!;
      assert.equal(dip.flagged, true);
      assert.ok(r.ask === null || r.ask > dip.landedCents);
      found++;
    }
    assert.ok(e.log.filter((l) => l.kind === 'BUY').every((l) => !/set aside/.test(l.text)));
  }
  assert.ok(found > 0, 'the simulation does produce bait');
});

test('the agents never overspend, and cash plus lots reconcile with realized profit', () => {
  const e = createEngine(sets(), NOW + 2 * 86_400_000);
  for (const a of e.agents) {
    assert.ok(a.cash >= 0);
    assert.ok(a.lots.length <= a.rule.maxLots);
    const invested = a.lots.reduce((s, l) => s + l.costCents, 0);
    assert.equal(a.cash + invested, a.startCash + a.realized, `${a.rule.name}: cash + open cost = start + realized`);
  }
});

test('a margin floor is respected at entry: a buy always clears its agent\'s floor', () => {
  const e = createEngine(caseP(), NOW + 86_400_000);
  const buys = e.log.filter((l) => l.kind === 'BUY');
  assert.ok(buys.length > 0, 'something was bought over a day');
  for (const b of buys) {
    const m = b.text.match(/would net (-?[\d.]+)%/);
    const floor = AGENT_RULES.find((r) => r.name === b.agent)!.floorBps / 100;
    assert.ok(m && Number(m[1]) >= floor - 0.05, `${b.agent}: ${b.text}`);
  }
});

test('most rounds are honest passes: normal books cannot beat the fees', () => {
  const e = createEngine(phone(), NOW);
  const noGap = e.rounds.filter((r) => !r.gap).length;
  assert.ok(noGap / e.rounds.length > 0.6);
  const sniper = e.agents.find((a) => a.rule.id === 'sniper')!;
  assert.ok(/No gap|Gap|Bought/.test(sniper.stance));
  // two sellers a few percent apart never clear a 15% fee load
  const r = e.rounds.find((x) => !x.gap && x.next)!;
  assert.ok((r.next! - r.askPrice) / r.askPrice < (FEE_BPS + 200) / 10_000);
});

test('seriesOf thins long windows and keeps the last price', () => {
  const e = createEngine(phone(), NOW);
  const s = seriesOf(e, 3600, 300);
  assert.ok(s.length <= 300);
  assert.equal(s.at(-1)!.y, e.rounds.at(-1)!.ask);
});

test('the book has identical offers sorted cheapest first, with a considered count above them', () => {
  const e = createEngine(sets(), NOW);
  const r = e.rounds.at(-1)!;
  const b = e.book(r.n)!;
  assert.ok(b.considered > b.offers.length);
  assert.deepEqual(b.offers.map((o) => o.landedCents), [...b.offers.map((o) => o.landedCents)].sort((x, y) => x - y));
  assert.equal(r.ask, b.offers.find((o) => !o.flagged)!.landedCents);
});
