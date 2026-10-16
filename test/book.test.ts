import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arbitrage } from '../src/economics.ts';
import { average, bidsFor, ceilingCents, POLICIES, vsAvg, winner } from '../web/src/lib/book.ts';

const costs = { marketplaceFeeBps: 1300, returnReserveBps: 200, outboundShippingCents: 1500 };
const check = (landed: number[], sell: number | null) => ({
  identical: landed.map((landedCents) => ({ landedCents })),
  buy: landed.length ? { landedCents: Math.min(...landed) } : null,
  arbitrage: sell === null ? null : { sellReference: { priceCents: sell } },
  assumptions: costs,
});

test('a bid at the ceiling clears the floor and one more cent per percent does not', () => {
  for (const sell of [4900, 32000, 67999, 129900]) for (const floor of [0, 500, 1000, 2000]) {
    const c = ceilingCents(sell, costs, floor)!;
    const at = arbitrage({ priceCents: c, shippingCents: 0, dutyBps: 0, vatBps: 0, paymentFeeBps: 0 }, { sellCents: sell, ...costs }, floor);
    assert.ok(at.marginBps >= floor - 2, `sell ${sell} floor ${floor}: margin ${at.marginBps}`);
    const over = arbitrage({ priceCents: c + Math.max(5, Math.round(c * 0.01)), shippingCents: 0, dutyBps: 0, vatBps: 0, paymentFeeBps: 0 }, { sellCents: sell, ...costs }, floor);
    assert.ok(over.marginBps < floor, `sell ${sell} floor ${floor}: just above the ceiling must miss the floor`);
  }
});

test('a cheap item has no ceiling when postage and fees eat the resale price', () => {
  assert.equal(ceilingCents(1500, costs, 0), null);
});

test('stricter policies bid lower, and the order is highest first', () => {
  const bids = bidsFor(check([60000, 65000, 68000], 65000), 1000);
  assert.equal(bids.length, POLICIES.length);
  const c = bids.map((b) => b.ceilingCents!);
  assert.deepEqual(c, [...c].sort((a, b) => b - a));
  assert.equal(bids[0].policy.id, 'scout');
  assert.equal(bids.at(-1)!.policy.id, 'patient');
  assert.equal(bids.find((b) => b.policy.id === 'live')!.floorBps, 1000);
});

test('with normal prices nobody reaches the best ask, with a real gap the most generous bid does', () => {
  const normal = bidsFor(check([60000, 62000, 65000], 62000), 1000);
  assert.equal(winner(normal), null);
  assert.ok(normal.every((b) => b.gapPct! > 0));
  const gap = bidsFor(check([42000, 62000, 65000], 62000), 1000);
  const w = winner(gap)!;
  assert.ok(w);
  assert.equal(w.policy.id, 'scout', 'the highest bid that reaches the ask is first in line');
  assert.ok(gap.filter((b) => b.crosses).length >= 1);
});

test('no resale reference, no bids', () => {
  assert.deepEqual(bidsFor(check([60000], null), 1000), []);
});

test('average and distance from it', () => {
  assert.equal(average([100, 200, 300]), 200);
  assert.equal(average([]), null);
  assert.equal(vsAvg(150, 200), -25);
  assert.equal(vsAvg(150, null), null);
});
