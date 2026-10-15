import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefingFor, validateNote, buildBriefingPrompt, type BriefingFacts } from '../src/briefing.ts';

const facts: BriefingFacts = {
  query: 'LEGO 10294 Titanic', currency: 'USD', listings: 30, identical: 7, flagged: 2, retailCents: 67999,
  buy: { seller: 'Mercari', landedCents: 64500 },
  arbitrage: { verdict: 'loss', netCents: -8201, marginBps: -1271, sellCents: 67999 },
};

test('a note that only uses the given numbers is accepted', () => {
  const note = 'Of 30 listings, 7 passed the identity gate. The cheapest is 645 at Mercari, and reselling at 679.99 loses 82.01.';
  assert.equal(validateNote(note, facts), note);
});

test('a note with an invented number is rejected', () => {
  assert.equal(validateNote('The cheapest is 645 and the set usually sells for 900.', facts), null);
});

test('an empty or overlong note is rejected', () => {
  assert.equal(validateNote('   ', facts), null);
  assert.equal(validateNote('x'.repeat(700), facts), null);
});

test('the prompt carries the facts and forbids inventing numbers', () => {
  const p = buildBriefingPrompt(facts);
  assert.match(p, /645/);
  assert.match(p, /Do not add any other number/);
});

test('briefingFor returns null when the model call fails or returns junk', async () => {
  assert.equal(await briefingFor(async () => { throw new Error('503'); }, facts), null);
  assert.equal(await briefingFor(async () => 'not json', facts), null);
  assert.equal(await briefingFor(async () => '{"note": 42}', facts), null);
});

test('briefingFor passes a grounded note through', async () => {
  const note = 'Seven of 30 listings passed.';
  assert.equal(await briefingFor(async () => JSON.stringify({ note }), facts), note);
});
