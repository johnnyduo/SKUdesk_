import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseResult, passesGate, createIdentityEngine, type Listing } from '../src/identity.ts';

const a: Listing = { id: 'a', title: 'LEGO 75192 Millennium Falcon UCS', condition: 'new_sealed' };
const b: Listing = { id: 'b', title: 'LEGO Star Wars Ultimate Collector Series Millennium Falcon 75192', condition: 'new_sealed' };

test('parseResult accepts a well-formed verdict', () => {
  const r = parseResult(JSON.stringify({ verdict: 'identical', confidence: 0.97, reasons: ['same set number 75192'], mismatches: [] }));
  assert.equal(r.verdict, 'identical');
  assert.equal(r.confidence, 0.97);
});

test('parseResult strips a markdown code fence', () => {
  const body = JSON.stringify({ verdict: 'different', confidence: 0.9, reasons: [], mismatches: ['set number'] });
  assert.equal(parseResult('```json\n' + body + '\n```').verdict, 'different');
});

test('parseResult rejects anything it cannot trust', () => {
  assert.throws(() => parseResult('not json'));
  assert.throws(() => parseResult(JSON.stringify({ verdict: 'maybe', confidence: 0.5, reasons: [], mismatches: [] })));
  assert.throws(() => parseResult(JSON.stringify({ verdict: 'identical', confidence: 1.4, reasons: [], mismatches: [] })));
  assert.throws(() => parseResult(JSON.stringify({ verdict: 'identical', reasons: [], mismatches: [] })));
});

test('gate passes only identical at or above the confidence floor', () => {
  const r = (verdict: 'identical' | 'different' | 'uncertain', confidence: number) => ({ verdict, confidence, reasons: [], mismatches: [] });
  assert.equal(passesGate(r('identical', 0.95)), true);
  assert.equal(passesGate(r('identical', 0.89)), false);
  assert.equal(passesGate(r('uncertain', 0.99)), false);
  assert.equal(passesGate(r('different', 0.99)), false);
});

test('prompt carries both listings and the condition rule', () => {
  const p = buildPrompt(a, b);
  assert.match(p, /75192/);
  assert.match(p, /Listing A/);
  assert.match(p, /Listing B/);
  assert.match(p, /factory-sealed/i);
});

test('engine returns the parsed model verdict', async () => {
  const engine = createIdentityEngine(async () =>
    JSON.stringify({ verdict: 'identical', confidence: 0.96, reasons: ['same set number'], mismatches: [] }));
  assert.equal((await engine.compare(a, b)).verdict, 'identical');
});

test('engine fails closed: an unparseable reply becomes uncertain, never identical', async () => {
  const engine = createIdentityEngine(async () => 'sure, looks the same!');
  const r = await engine.compare(a, b);
  assert.equal(r.verdict, 'uncertain');
  assert.equal(passesGate(r), false);
});

test('engine fails closed when the model call throws', async () => {
  const engine = createIdentityEngine(async () => { throw new Error('503'); });
  const r = await engine.compare(a, b);
  assert.equal(r.verdict, 'uncertain');
});
