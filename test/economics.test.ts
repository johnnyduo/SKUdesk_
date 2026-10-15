import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arbitrage, landed } from '../src/economics.ts';

const buy = { priceCents: 10_000, shippingCents: 1_000, dutyBps: 500, vatBps: 700, paymentFeeBps: 290 };

test('landed cost stacks duty, vat and payment fee on the running subtotal', () => {
  // goods 11000; duty 550; vat on 11550 = 808.5 -> 809; payment on 12359 = 358.411 -> 358
  const l = landed(buy);
  assert.deepEqual(l.steps.map((s) => s.cents), [10_000, 1_000, 550, 809, 358]);
  assert.equal(l.landedCents, 12_717);
});

test('profitable trade clears the minimum margin', () => {
  const r = arbitrage(buy, { sellCents: 18_000, marketplaceFeeBps: 800, outboundShippingCents: 600, returnReserveBps: 200 });
  // fee 1440, reserve 360 -> net 18000-1440-360-600-12717 = 2883
  assert.equal(r.netCents, 2_883);
  assert.equal(r.verdict, 'profitable');
});

test('a price gap that costs eat is reported as loss, not a win', () => {
  const r = arbitrage(buy, { sellCents: 13_000, marketplaceFeeBps: 800, outboundShippingCents: 600, returnReserveBps: 200 });
  assert.equal(r.verdict, 'loss');
  assert.ok(r.netCents < 0);
});

test('small positive net below the margin floor is thin', () => {
  const r = arbitrage(buy, { sellCents: 15_200, marketplaceFeeBps: 800, outboundShippingCents: 600, returnReserveBps: 200 });
  assert.equal(r.verdict, 'thin');
});
