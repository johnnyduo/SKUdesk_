import type { Generate } from './identity.ts';
import { cached, type Store } from './store.ts';

// Identity says two listings are the same product; it cannot say a price is believable. This asks Gemini for the
// typical new retail price of the product so absurdly low prices (bait, accessories, imitations) can be set aside.
// It is recalled knowledge, not a live quote, and the UI says so. A wrong answer can only hide offers, never add any.

export interface RetailEstimate {
  cents: number | null;
  confidence: 'high' | 'medium' | 'low';
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function buildRetailPrompt(query: string, currency: string): string {
  return `What is the typical new, factory-sealed retail price in ${currency} of this exact product: "${query}"?
Answer only if you know this specific product. If you are unsure, use null. Do not guess from similar products.
Reply with JSON only: {"price": number or null, "confidence": "high" | "medium" | "low"}`;
}

export function parseRetail(text: string): RetailEstimate {
  const o = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as { price?: unknown; confidence?: unknown };
  const conf = o.confidence === 'high' || o.confidence === 'medium' ? o.confidence : 'low';
  const price = typeof o.price === 'number' && Number.isFinite(o.price) && o.price > 0 ? Math.round(o.price * 100) : null;
  return { cents: conf === 'low' ? null : price, confidence: conf };
}

export async function estimateRetail(generate: Generate, store: Store, query: string, currency: string): Promise<RetailEstimate> {
  try {
    const { value } = await cached(store, `retail|${currency}|${query.trim().toLowerCase()}`, TTL_MS, async () => parseRetail(await generate(buildRetailPrompt(query, currency))));
    return value;
  } catch {
    return { cents: null, confidence: 'low' };
  }
}
