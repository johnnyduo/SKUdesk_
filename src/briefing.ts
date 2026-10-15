import type { Generate } from './identity.ts';

// A short plain-language note from Gemini, grounded in numbers the code already computed.
// Every number in the reply must come from the facts; otherwise the note is dropped and the page shows the
// deterministic headline only. The model explains. It never decides and never supplies a figure.

export interface BriefingFacts {
  query: string;
  currency: string;
  listings: number;
  identical: number;
  flagged: number;
  retailCents: number | null;
  buy: { seller: string; landedCents: number };
  arbitrage: { verdict: string; netCents: number; marginBps: number; sellCents: number } | null;
}

const major = (cents: number): number => Math.round(cents) / 100;

export function buildBriefingPrompt(f: BriefingFacts): string {
  const facts = {
    product: f.query,
    currency: f.currency,
    listings_checked: f.listings,
    passed_identity_gate: f.identical,
    offers_with_unbelievable_price_set_aside: f.flagged,
    recalled_retail_price: f.retailCents === null ? null : major(f.retailCents),
    cheapest_identical: { seller: f.buy.seller, landed_cost: major(f.buy.landedCents) },
    resale: f.arbitrage && { verdict: f.arbitrage.verdict, resale_price: major(f.arbitrage.sellCents), net_after_all_costs: major(f.arbitrage.netCents), margin_percent: Math.round(f.arbitrage.marginBps) / 100 },
  };
  return `You write a two or three sentence note for a buyer, from FACTS about one product search.
Rules: use only numbers that appear in FACTS, written exactly as given. Do not add any other number, date or price. Do not tell the reader to buy. Say plainly if there is no resale gap. No markdown, no emoji.
FACTS:
${JSON.stringify(facts)}
Reply with JSON only: {"note": string}`;
}

const NUM = /\d[\d,]*(?:\.\d+)?/g;
const norm = (s: string): string => {
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : s;
};

export function allowedNumbers(f: BriefingFacts): Set<string> {
  return new Set((buildBriefingPrompt(f).split('FACTS:')[1].match(NUM) ?? []).map(norm));
}

// Returns the note only if every number in it is one of the facts.
export function validateNote(note: string, f: BriefingFacts): string | null {
  const text = note.trim();
  if (!text || text.length > 600) return null;
  const allowed = allowedNumbers(f);
  for (const n of text.match(NUM) ?? []) if (!allowed.has(norm(n))) return null;
  return text;
}

export async function briefingFor(generate: Generate, f: BriefingFacts): Promise<string | null> {
  try {
    const raw = await generate(buildBriefingPrompt(f));
    const o = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as { note?: unknown };
    return typeof o.note === 'string' ? validateNote(o.note, f) : null;
  } catch {
    return null;
  }
}
