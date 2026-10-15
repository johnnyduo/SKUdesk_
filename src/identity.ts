// Identity Engine: the single gate deciding whether two listings are the SAME product.
// Nothing downstream (landed cost, arbitrage) runs unless a pair clears this gate.
// It fails closed: any error or unparseable reply becomes 'uncertain', which never passes.

export type Condition = 'new_sealed' | 'new_open' | 'used' | 'unknown';

export interface Listing {
  id: string;
  title: string;
  description?: string;
  gtin?: string;
  brand?: string;
  condition?: Condition;
  imageUrl?: string;
}

export type IdentityVerdict = 'identical' | 'different' | 'uncertain';

export interface IdentityResult {
  verdict: IdentityVerdict;
  confidence: number;
  reasons: string[];
  mismatches: string[];
}

export type Generate = (prompt: string) => Promise<string>;

export const MIN_CONFIDENCE = 0.9;

const VERDICTS: readonly string[] = ['identical', 'different', 'uncertain'];

function describe(label: string, l: Listing): string {
  const lines = [`${label}:`, `  title: ${l.title}`];
  if (l.brand) lines.push(`  brand: ${l.brand}`);
  if (l.gtin) lines.push(`  gtin: ${l.gtin}`);
  if (l.condition) lines.push(`  condition: ${l.condition}`);
  if (l.description) lines.push(`  description: ${l.description}`);
  return lines.join('\n');
}

export function buildPrompt(a: Listing, b: Listing): string {
  return `You decide whether two retail listings are for the IDENTICAL product, so that buying one and reselling as the other is safe.

"identical" means a buyer would receive the same physical item either way:
- same brand and same model/set number (a different set number is always different, even in the same theme or with similar names)
- same edition and same contents (a bundle, a polybag, a minifigure-only or instructions-only listing is not the full set)
- same condition class: both factory-sealed new. A used, opened, damaged-seal or incomplete listing is different from a factory-sealed one.
- a regional box or a different GTIN/EAN for the same set number is still identical (retailers use per-region barcodes)
- imitation or "compatible" building-block brands are never identical to the genuine brand

Answer "uncertain" when the text does not give enough evidence to be sure either way. Never guess "identical".
Identifier rule: first read the explicit set/model number (or GTIN) from each listing, writing "none" if the text has no such number. If exactly one listing has an identifier and the other has "none", the verdict is "uncertain", even if the unnumbered title seems to match a well-known product. Never fill in a missing number from memory.
Do not use outside price knowledge. Judge only from the two listings.

${describe('Listing A', a)}

${describe('Listing B', b)}

Reply with JSON only:
{"idA": "number or none", "idB": "number or none", "verdict": "identical" | "different" | "uncertain", "confidence": number between 0 and 1, "reasons": [short strings], "mismatches": [short strings naming each differing attribute]}`;
}

export function parseResult(text: string): IdentityResult {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const raw: unknown = JSON.parse(body);
  if (typeof raw !== 'object' || raw === null) throw new Error('identity reply is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.verdict !== 'string' || !VERDICTS.includes(o.verdict)) throw new Error('identity reply has an invalid verdict');
  if (typeof o.confidence !== 'number' || !(o.confidence >= 0 && o.confidence <= 1)) throw new Error('identity reply has an invalid confidence');
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  return {
    verdict: o.verdict as IdentityVerdict,
    confidence: o.confidence,
    reasons: strings(o.reasons),
    mismatches: strings(o.mismatches),
  };
}

export function passesGate(r: IdentityResult, minConfidence: number = MIN_CONFIDENCE): boolean {
  return r.verdict === 'identical' && r.confidence >= minConfidence;
}

export function createIdentityEngine(generate: Generate) {
  return {
    async compare(a: Listing, b: Listing): Promise<IdentityResult> {
      try {
        return parseResult(await generate(buildPrompt(a, b)));
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return { verdict: 'uncertain', confidence: 0, reasons: [], mismatches: [`engine error: ${why}`] };
      }
    },
  };
}
