import type { Market, Offer } from './types.ts';
import { cached, type Store } from './store.ts';

// eBay Browse API adapter (client-credentials OAuth). It stays off until EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are set.
// Status: parser covered by a test on a sample shaped like the documented response; not yet exercised against the live API.

const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;

interface EbayItem {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  seller?: { username?: string };
  condition?: string;
  shippingOptions?: { shippingCost?: { value?: string }; shippingCostType?: string }[];
}

export function parseEbay(json: unknown, market: Market): Offer[] {
  const items = (json as { itemSummaries?: EbayItem[] } | null)?.itemSummaries ?? [];
  const offers: Offer[] = [];
  for (const it of items) {
    const value = Number(it.price?.value);
    if (!it.title || !it.itemId || !Number.isFinite(value) || value <= 0) continue;
    if (it.price?.currency && it.price.currency !== market.currency) continue;
    const ship = it.shippingOptions?.[0];
    const shipValue = ship?.shippingCost?.value;
    offers.push({
      id: it.itemId,
      title: it.title,
      seller: `eBay - ${it.seller?.username ?? 'seller'}`,
      channel: 'marketplace',
      priceCents: Math.round(value * 100),
      currency: market.currency,
      shippingCents: ship?.shippingCostType === 'FIXED' && shipValue !== undefined ? Math.round(Number(shipValue) * 100) : null,
      secondHand: /used|pre-owned|refurbished|parts/i.test(it.condition ?? ''),
      url: it.itemWebUrl ?? '',
      thumbnail: it.image?.imageUrl,
      origin: 'ebay',
    });
  }
  return offers;
}

export interface EbayDeps {
  clientId: string;
  clientSecret: string;
  store: Store;
  fetch?: typeof fetch;
}

let token: { value: string; expiresAt: number } | null = null;

async function accessToken(d: EbayDeps): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const res = await (d.fetch ?? fetch)('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${d.clientId}:${d.clientSecret}`).toString('base64')}` },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!res.ok) throw new Error(`eBay OAuth HTTP ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return token.value;
}

export async function searchEbay(query: string, market: Market, d: EbayDeps, opts: { fresh?: boolean } = {}): Promise<Offer[]> {
  const { value } = await cached(d.store, `ebay|${market.code}|${query.trim().toLowerCase()}`, SEARCH_TTL_MS, async () => {
    const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search');
    url.search = new URLSearchParams({ q: query, limit: '40', filter: 'conditions:{NEW}', sort: 'price' }).toString();
    const res = await (d.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${await accessToken(d)}`, 'x-ebay-c-marketplace-id': `EBAY_${market.gl.toUpperCase()}` } });
    if (!res.ok) throw new Error(`eBay search HTTP ${res.status}`);
    return parseEbay(await res.json(), market);
  }, opts);
  return value;
}
