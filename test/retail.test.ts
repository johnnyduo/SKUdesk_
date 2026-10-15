import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRetail, estimateRetail, buildRetailPrompt } from '../src/retail.ts';
import { MemoryStore } from '../src/store.ts';

test('parseRetail converts a confident price to cents', () => {
  assert.deepEqual(parseRetail('{"price": 679.99, "confidence": "high"}'), { cents: 67999, confidence: 'high' });
});

test('parseRetail ignores low confidence, null and nonsense prices', () => {
  assert.equal(parseRetail('{"price": 50, "confidence": "low"}').cents, null);
  assert.equal(parseRetail('{"price": null, "confidence": "high"}').cents, null);
  assert.equal(parseRetail('{"price": -5, "confidence": "high"}').cents, null);
  assert.equal(parseRetail('{"price": "cheap", "confidence": "high"}').cents, null);
});

test('estimateRetail caches by query and currency, and fails to "unknown", not to a guess', async () => {
  const store = new MemoryStore();
  let calls = 0;
  const gen = async () => (calls++, '{"price": 100, "confidence": "medium"}');
  assert.equal((await estimateRetail(gen, store, 'X', 'USD')).cents, 10000);
  await estimateRetail(gen, store, 'x', 'USD');
  assert.equal(calls, 1);
  const broken = await estimateRetail(async () => { throw new Error('503'); }, store, 'other', 'USD');
  assert.equal(broken.cents, null);
});

test('prompt names the product and currency', () => {
  assert.match(buildRetailPrompt('LEGO 10294', 'GBP'), /LEGO 10294/);
  assert.match(buildRetailPrompt('LEGO 10294', 'GBP'), /GBP/);
});
