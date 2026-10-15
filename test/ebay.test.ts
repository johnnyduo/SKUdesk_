import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEbay } from '../src/ebay.ts';
import { MARKETS } from '../src/serpapi.ts';

// A sample shaped like the documented Browse API item_summary/search response. It is NOT a captured live response.
const sample = {
  itemSummaries: [
    { itemId: 'v1|1|0', title: 'LEGO 10294 Titanic NEW', price: { value: '629.99', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/1', seller: { username: 'brickshop' }, condition: 'New', shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '0.00' } }] },
    { itemId: 'v1|2|0', title: 'LEGO 10294 Titanic open box', price: { value: '500.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/2', seller: { username: 'b2' }, condition: 'Pre-owned', shippingOptions: [{ shippingCostType: 'CALCULATED' }] },
    { itemId: 'v1|3|0', title: 'wrong currency', price: { value: '10', currency: 'EUR' } },
    { title: 'no id', price: { value: '10', currency: 'USD' } },
  ],
};

test('parseEbay keeps valid same-currency items and converts to cents', () => {
  const offers = parseEbay(sample, MARKETS.us);
  assert.equal(offers.length, 2);
  assert.equal(offers[0].priceCents, 62999);
  assert.equal(offers[0].shippingCents, 0);
  assert.equal(offers[0].seller, 'eBay - brickshop');
  assert.equal(offers[0].channel, 'marketplace');
  assert.equal(offers[1].shippingCents, null);
  assert.equal(offers[1].secondHand, true);
});

test('parseEbay tolerates an empty response', () => {
  assert.deepEqual(parseEbay({}, MARKETS.us), []);
  assert.deepEqual(parseEbay(null, MARKETS.us), []);
});
