import type { Channel, Market, Offer } from './types.ts';
import { cached, hashKey, type Quota, type Store } from './store.ts';

export const MARKETS: Record<string, Market> = {
  us: { code: 'us', label: 'United States', gl: 'us', hl: 'en', currency: 'USD' },
  gb: { code: 'gb', label: 'United Kingdom', gl: 'gb', hl: 'en', currency: 'GBP' },
  de: { code: 'de', label: 'Germany', gl: 'de', hl: 'en', currency: 'EUR' },
  ca: { code: 'ca', label: 'Canada', gl: 'ca', hl: 'en', currency: 'CAD' },
  au: { code: 'au', label: 'Australia', gl: 'au', hl: 'en', currency: 'AUD' },
};

const SEARCH_TTL_MS = 12 * 60 * 60 * 1000;

const MARKETPLACE = /^(ebay|mercari|etsy|poshmark|depop|stockx|whatnot|offerup|aliexpress|temu|walmart - |amazon - )/i;

export const channelOf = (source: string): Channel => (MARKETPLACE.test(source.trim()) ? 'marketplace' : 'retailer');

// "Free delivery" -> 0, "$5.99 delivery" -> 599, anything else (or nothing) -> null (unknown).
export function parseShipping(delivery: string | undefined): number | null {
  if (!delivery) return null;
  if (/\bfree\b/i.test(delivery)) return 0;
  const m = delivery.match(/([\d][\d,]*(?:\.\d{1,2})?)\s*(?:delivery|shipping)/i) ?? delivery.match(/(?:delivery|shipping)[^\d]*([\d][\d,]*(?:\.\d{1,2})?)/i);
  return m ? Math.round(parseFloat(m[1].replace(/,/g, '')) * 100) : null;
}

interface RawResult {
  title?: string;
  product_id?: string;
  source?: string;
  extracted_price?: number;
  second_hand_condition?: string;
  delivery?: string;
  product_link?: string;
  link?: string;
  thumbnail?: string;
}

export function parseShopping(json: unknown, market: Market): Offer[] {
  const rows = ((json as { shopping_results?: RawResult[] } | null)?.shopping_results ?? []);
  const offers: Offer[] = [];
  for (const r of rows) {
    if (!r.title || typeof r.extracted_price !== 'number' || r.extracted_price <= 0) continue;
    const source = r.source ?? 'unknown';
    offers.push({
      id: r.product_id ?? hashKey(`${source}|${r.title}|${r.extracted_price}`),
      title: r.title,
      seller: source,
      channel: channelOf(source),
      priceCents: Math.round(r.extracted_price * 100),
      currency: market.currency,
      shippingCents: parseShipping(r.delivery),
      secondHand: Boolean(r.second_hand_condition),
      url: r.link ?? r.product_link ?? '',
      thumbnail: r.thumbnail,
      origin: 'serpapi',
    });
  }
  return offers;
}

export interface SerpDeps {
  apiKey: string;
  store: Store;
  quota: Quota;
  fetch?: typeof fetch;
}

// One paid search per (query, market) per 12 hours. Returns the offers and whether the cache answered.
export async function searchShopping(query: string, market: Market, deps: SerpDeps, opts: { fresh?: boolean } = {}): Promise<{ offers: Offer[]; fromCache: boolean }> {
  const key = `serpapi|google_shopping|${market.gl}|${query.trim().toLowerCase()}`;
  const { value, hit } = await cached(deps.store, key, SEARCH_TTL_MS, async () => {
    await deps.quota.reserve();
    const url = new URL('https://serpapi.com/search.json');
    url.search = new URLSearchParams({ engine: 'google_shopping', q: query, gl: market.gl, hl: market.hl, api_key: deps.apiKey }).toString();
    const res = await (deps.fetch ?? fetch)(url);
    if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);
    const json = (await res.json()) as { error?: string };
    if (json.error && !/hasn't returned any results/i.test(json.error)) throw new Error(`SerpApi: ${json.error}`);
    return parseShopping(json, market);
  }, opts);
  return { offers: value, fromCache: hit };
}
