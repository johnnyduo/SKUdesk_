import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseResult, passesGate, createIdentityEngine, verifyEvidence, type IdentityResult, type Listing } from '../src/identity.ts';

const a: Listing = { id: 'a', title: 'LEGO 75192 Millennium Falcon UCS', condition: 'new_sealed' };
const b: Listing = { id: 'b', title: 'LEGO Star Wars Ultimate Collector Series Millennium Falcon 75192', condition: 'new_sealed' };
const evidenceOk = { brand: 'LEGO', brandQuoteA: 'LEGO', brandQuoteB: 'LEGO', idA: '75192', idB: '75192' };

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
  assert.match(p, /factory-new and sealed/i);
  assert.match(p, /storage capacity/i);
});

test('engine returns the parsed model verdict', async () => {
  const engine = createIdentityEngine(async () => JSON.stringify({ ...evidenceOk, verdict: 'identical', confidence: 0.96, reasons: ['same set number'], mismatches: [] }));
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

test('prompt tells the model that listing text is untrusted', () => {
  assert.match(buildPrompt(a, b), /untrusted data/);
});

const claim = (over: Record<string, unknown> = {}): IdentityResult =>
  parseResult(JSON.stringify({ ...evidenceOk, verdict: 'identical', confidence: 0.99, reasons: ['r'], mismatches: [], ...over }));
const bare: Listing = { id: 'c', title: 'Millennium Falcon Building Blocks 75192 Bricks', condition: 'new_sealed' };

test('evidence check keeps an identical verdict whose quotes are really in both listings', () => {
  assert.equal(verifyEvidence(a, b, claim()).verdict, 'identical');
});

test('evidence check downgrades a brand the listing never wrote (the model credited it from memory)', () => {
  const r = verifyEvidence(a, bare, claim({ brandQuoteB: 'LEGO' }));
  assert.equal(r.verdict, 'uncertain');
  assert.match(r.mismatches.join(' '), /brand not found in listing B/);
  assert.equal(passesGate(r), false);
});

test('evidence check downgrades when the model names no brand at all', () => {
  assert.equal(verifyEvidence(a, bare, claim({ brand: 'none', brandQuoteB: 'none' })).verdict, 'uncertain');
});

test('evidence check downgrades identifiers that do not match or are not in the text', () => {
  assert.equal(verifyEvidence(a, b, claim({ idB: '75257' })).verdict, 'uncertain');
  assert.equal(verifyEvidence(a, b, claim({ idA: '99999', idB: '99999' })).verdict, 'uncertain');
});

test('evidence check accepts a brand written in another script when quotes are verbatim', () => {
  const thai: Listing = { id: 't', title: 'เลโก้ 10302 ออพติมัส ไพรม์ ของใหม่', condition: 'new_sealed' };
  const en: Listing = { id: 'e', title: 'LEGO Icons Optimus Prime 10302', condition: 'new_sealed' };
  assert.equal(verifyEvidence(thai, en, claim({ brand: 'LEGO', brandQuoteA: 'เลโก้', brandQuoteB: 'LEGO', idA: '10302', idB: '10302' })).verdict, 'identical');
});

test('evidence check leaves different and uncertain verdicts alone', () => {
  assert.equal(verifyEvidence(a, bare, claim({ verdict: 'different', brand: 'none' })).verdict, 'different');
});

// ── phones: storage and model tier are read by code, not trusted to the model ──
const phone = (title: string): Listing => ({ id: title, title, condition: 'new_sealed' });
const phoneEvidence = (idA: string, idB: string) => ({ brand: 'Apple', brandQuoteA: 'Apple', brandQuoteB: 'Apple', idA, idB, variantA: null, variantB: null });
const claimsIdentical = (idA: string, idB: string): IdentityResult => ({ verdict: 'identical', confidence: 0.98, reasons: ['same'], mismatches: [], evidence: phoneEvidence(idA, idB) });

test('a model that says identical cannot override a different storage size in the text', () => {
  const r = verifyEvidence(phone('Apple iPhone 16 Pro 256GB'), phone('Apple iPhone 16 Pro 512GB Natural Titanium'), claimsIdentical('iPhone 16 Pro', 'iPhone 16 Pro'));
  assert.equal(r.verdict, 'different');
  assert.match(r.mismatches.join(' '), /storage differs \(256 GB vs 512 GB\)/);
  assert.equal(passesGate(r), true === false);
});

test('1 TB and 1024 GB are the same size', () => {
  const r = verifyEvidence(phone('Apple iPhone 16 Pro 1TB'), phone('Apple iPhone 16 Pro 1024GB'), claimsIdentical('iPhone 16 Pro', 'iPhone 16 Pro'));
  assert.equal(r.verdict, 'identical');
});

test('Pro and Pro Max are different models even when the model says identical', () => {
  const r = verifyEvidence(phone('Apple iPhone 16 Pro 256GB'), phone('Apple iPhone 16 Pro Max 256GB'), claimsIdentical('iPhone 16 Pro', 'iPhone 16 Pro'));
  assert.equal(r.verdict, 'different');
  assert.match(r.mismatches.join(' '), /model tier differs/);
});

test('a plain model against its Plus or Ultra is different', () => {
  assert.equal(verifyEvidence(phone('Samsung Galaxy S25 256GB'), phone('Samsung Galaxy S25 Ultra 256GB'), { ...claimsIdentical('Galaxy S25', 'Galaxy S25'), evidence: { ...phoneEvidence('Galaxy S25', 'Galaxy S25'), brand: 'Samsung', brandQuoteA: 'Samsung', brandQuoteB: 'Samsung' } }).verdict, 'different');
});

test('storage stated by only one listing is uncertain, not identical', () => {
  const r = verifyEvidence(phone('Apple iPhone 16 Pro'), phone('Apple iPhone 16 Pro 256GB'), claimsIdentical('iPhone 16 Pro', 'iPhone 16 Pro'));
  assert.equal(r.verdict, 'uncertain');
  assert.match(r.mismatches.join(' '), /only one listing states a storage capacity/);
});

test('same storage and tier pass through untouched', () => {
  const r = verifyEvidence(phone('Apple iPhone 16 Pro 256GB'), phone('iPhone 16 Pro (256 GB) Apple unlocked new'), claimsIdentical('iPhone 16 Pro', 'iPhone 16 Pro'));
  assert.equal(r.verdict, 'identical');
});

test('LEGO sets are not affected by the phone checks', () => {
  const r = verifyEvidence({ id: 'a', title: 'LEGO 75192 Millennium Falcon', condition: 'new_sealed' }, { id: 'b', title: 'LEGO Star Wars 75192 Ultimate Collector Series', condition: 'new_sealed' }, { verdict: 'identical', confidence: 0.97, reasons: [], mismatches: [], evidence: { brand: 'LEGO', brandQuoteA: 'LEGO', brandQuoteB: 'LEGO', idA: '75192', idB: '75192' } });
  assert.equal(r.verdict, 'identical');
});

test('RAM sizes are not mistaken for storage', () => {
  const r = verifyEvidence(phone('Google Pixel 9 Pro 16GB RAM 256GB'), phone('Google Pixel 9 Pro 256GB unlocked'), { ...claimsIdentical('Pixel 9 Pro', 'Pixel 9 Pro'), evidence: { ...phoneEvidence('Pixel 9 Pro', 'Pixel 9 Pro'), brand: 'Google', brandQuoteA: 'Google', brandQuoteB: 'Google' } });
  assert.equal(r.verdict, 'identical');
});

test('a quote that is not the brand does not stand for the brand', () => {
  const r = verifyEvidence({ id: 'a', title: 'LEGO Technic Ferrari Daytona SP3 42143', condition: 'new_sealed' }, { id: 'b', title: 'Ferrari Daytona Sp3 (42143) - Collectible Supercar Building Kit', condition: 'new_sealed' },
    { verdict: 'identical', confidence: 1, reasons: [], mismatches: [], evidence: { brand: 'LEGO', brandQuoteA: 'LEGO', brandQuoteB: 'Ferrari', idA: '42143', idB: '42143' } });
  assert.equal(r.verdict, 'uncertain');
  assert.match(r.mismatches.join(' '), /do not name the brand/);
});

test('another script for the same brand is accepted as its name', () => {
  const r = verifyEvidence({ id: 'a', title: 'レゴ アイコン コロッセオ 10276 新品未開封', condition: 'new_sealed' }, { id: 'b', title: 'LEGO Icons Colosseum 10276', condition: 'new_sealed' },
    { verdict: 'identical', confidence: 1, reasons: [], mismatches: [], evidence: { brand: 'LEGO', brandQuoteA: 'レゴ', brandQuoteB: 'LEGO', idA: '10276', idB: '10276' } });
  assert.equal(r.verdict, 'identical');
});
