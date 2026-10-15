// Runs the Identity Engine against the hand-labelled pairs with the REAL Gemini API.
// The one number that must be zero is false-identical: a pair labelled different/uncertain that passed the gate.
import { readFileSync, writeFileSync } from 'node:fs';
import { createIdentityEngine, passesGate, type IdentityResult, type IdentityVerdict, type Listing } from '../src/identity.ts';
import { geminiGenerate } from '../src/gemini.ts';

interface Pair {
  id: string;
  category: string;
  expected: IdentityVerdict;
  a: Listing;
  b: Listing;
  note: string;
}

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL;
if (!apiKey || !model) {
  console.error('GEMINI_API_KEY and GEMINI_MODEL must be set (run with: npm run eval)');
  process.exit(2);
}

const pairs: Pair[] = JSON.parse(readFileSync(new URL('./pairs.json', import.meta.url), 'utf8'));
const engine = createIdentityEngine(geminiGenerate(apiKey, model));

const results: { pair: Pair; got: IdentityResult; passed: boolean }[] = [];
const queue = [...pairs];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let p = queue.shift(); p; p = queue.shift()) {
    const got = await engine.compare(p.a, p.b);
    results.push({ pair: p, got, passed: passesGate(got) });
  }
}));
results.sort((x, y) => x.pair.id.localeCompare(y.pair.id));

let exact = 0, falseIdentical = 0, missedIdentical = 0, engineErrors = 0;
for (const { pair, got, passed } of results) {
  const ok = got.verdict === pair.expected;
  if (ok) exact++;
  const wrongPass = passed && pair.expected !== 'identical';
  const wrongBlock = !passed && pair.expected === 'identical';
  if (wrongPass) falseIdentical++;
  if (wrongBlock) missedIdentical++;
  if (got.mismatches.some((m) => m.startsWith('engine error'))) engineErrors++;
  const flag = wrongPass ? 'FALSE-IDENTICAL' : wrongBlock ? 'missed' : ok ? 'ok' : 'differs-safe';
  console.log(`${pair.id} ${flag.padEnd(15)} expected=${pair.expected.padEnd(9)} got=${got.verdict.padEnd(9)} conf=${got.confidence.toFixed(2)}  ${pair.note}`);
}

const summary = { model, pairs: results.length, exact, falseIdentical, missedIdentical, engineErrors };
console.log('\n' + JSON.stringify(summary));
writeFileSync(new URL('./last-run.json', import.meta.url), JSON.stringify({ summary, results }, null, 2));
process.exit(falseIdentical > 0 || engineErrors > 0 ? 1 : 0);
