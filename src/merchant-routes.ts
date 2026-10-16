import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLimits, logEvent } from './domain.ts';
import { SECURITY_HEADERS } from './security.ts';
import {
  MerchantError, centsToMicros, createClient, dataSourceName, deriveStatus, ensureDataSource, insertPath, listingImage, listingLink, missingFor, normalizeTitle,
  payloadHash, productInputPath, productPath, toProductInput, type Listing, type MerchantClient, type MerchantConfig,
} from './merchant.ts';
import type { Store } from './store.ts';
import type { Analysis, Proposal } from './types.ts';

export interface MerchantDeps {
  config: MerchantConfig;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface Io {
  store: Store;
  send(res: ServerResponse, status: number, body: unknown): void;
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  image(url: string): Promise<{ type: string; body: Buffer } | null>;
}

const OFFER_ID = /^l-[a-f0-9]{8,32}$/;
const STALE_MS = 5 * 60 * 1000;
const MAX_PRICE_CENTS = 100_000_000;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const usd = (cents: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/** The page a listing points to. Google reads the price, condition and availability from here and from the markup. */
export function listingPage(c: MerchantConfig, l: Listing): string {
  const link = listingLink(c, l.offerId);
  const ld = { '@context': 'https://schema.org', '@type': 'Product', name: l.title, description: l.description, image: listingImage(c, l.offerId), sku: l.offerId, offers: { '@type': 'Offer', url: link, priceCurrency: 'USD', price: (l.priceCents / 100).toFixed(2), availability: 'https://schema.org/InStock', itemCondition: 'https://schema.org/NewCondition' } };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(l.title)} | SKUdesk</title><meta name="description" content="${esc(l.description)}"><link rel="canonical" href="${esc(link)}"><link rel="icon" href="/favicon.svg">
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#0a0a0a;color:#f5f6f2}main{max-width:880px;margin:0 auto;padding:32px 16px;display:grid;gap:28px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}@media(max-width:700px){main{grid-template-columns:1fr}}.img{background:#fff;border-radius:14px;padding:12px;display:grid;place-items:center;aspect-ratio:1}.img img{max-width:100%;max-height:100%;object-fit:contain}h1{font-size:24px;line-height:1.25;margin:0 0 8px}.price{font-size:32px;font-weight:700;color:#ccff00;margin:8px 0}.meta{color:#a6aba3;margin:0 0 8px}a{color:#10e1ff}</style>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script></head><body><main>
<div class="img"><img src="/p/${esc(l.offerId)}/image" alt="${esc(l.title)}" width="480" height="480"></div>
<div><p class="meta"><a href="/">SKUdesk</a></p><h1>${esc(l.title)}</h1><div class="price">${esc(usd(l.priceCents))}</div>
<p class="meta">New · In stock</p><p>${esc(l.description)}</p><p class="meta">Item ${esc(l.offerId)}</p></div></main></body></html>`;
}

export function createMerchantRoutes(deps: MerchantDeps, io: Io) {
  const c = deps.config;
  let client: MerchantClient | null = null;
  const getClient = (): MerchantClient => (client ??= createClient({ config: c, fetch: deps.fetch, sleep: deps.sleep }));
  let statusCache: { at: number; body: Record<string, unknown> } | null = null;

  const fail = (res: ServerResponse, e: unknown): void => {
    if (e instanceof MerchantError) return io.send(res, e.status, { error: e.message, code: e.code });
    throw e;
  };
  const publicListing = (l: Listing, owner: boolean): Record<string, unknown> => {
    const { productName, hash: _h, ...rest } = l;
    return owner ? { ...rest, productName } : rest;
  };
  const needConfigured = (res: ServerResponse, needDs: boolean): boolean => {
    const missing = missingFor(c, needDs);
    if (!missing.length) return true;
    io.send(res, 503, { error: `Merchant Center is not connected yet. Still needed: ${missing.join(', ')}`, code: 'NOT_CONFIGURED', missing });
    return false;
  };

  async function refresh(l: Listing): Promise<Listing> {
    if (missingFor(c, false).length) return l;
    try {
      const p = await getClient().request<unknown>({ method: 'GET', path: productPath(c, l.offerId) });
      const d = deriveStatus(p, c.country);
      const next: Listing = { ...l, status: d.status, issues: d.issues, checkedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const cur = await io.store.get<Listing>('listings', l.offerId);
      if (cur && cur.status === 'DELETED') return cur;
      await io.store.set('listings', l.offerId, next);
      return next;
    } catch (e) {
      if (e instanceof MerchantError && e.code === 'MERCHANT_NOT_FOUND') { const next = { ...l, status: 'PROCESSING' as const, checkedAt: new Date().toISOString() }; await io.store.set('listings', l.offerId, next); return next; }
      return l;
    }
  }

  /** Returns true when the request was one of ours. */
  async function handle(req: IncomingMessage, res: ServerResponse, path: string, owner: boolean): Promise<boolean> {
    // ── the public page and its picture ──
    const page = path.match(/^\/p\/(l-[a-f0-9]{8,32})\/(image)?$/);
    if (page && req.method === 'GET') {
      const l = await io.store.get<Listing>('listings', page[1]);
      if (!l || l.status === 'DELETED' || l.status === 'DRAFT') { io.send(res, 404, { error: 'not found' }); return true; }
      if (page[2]) {
        const img = l.imageSource ? await io.image(l.imageSource) : null;
        if (!img) { io.send(res, 404, { error: 'no picture' }); return true; }
        res.writeHead(200, { 'content-type': img.type, 'cache-control': 'public, max-age=3600', ...SECURITY_HEADERS });
        res.end(img.body);
        return true;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', ...SECURITY_HEADERS });
      res.end(listingPage(c, l));
      return true;
    }

    if (!path.startsWith('/api/merchant')) return false;

    if (req.method === 'GET' && path === '/api/merchant/status') {
      const missing = missingFor(c, false);
      if (missing.length) { io.send(res, 200, { configured: false, missing, hasDataSource: Boolean(c.dataSourceId) }); return true; }
      if (!statusCache || Date.now() - statusCache.at > 60_000) {
        let body: Record<string, unknown>;
        try {
          const a = await getClient().request<{ accountName?: string }>({ method: 'GET', path: `/accounts/v1/accounts/${c.accountId}` });
          body = { configured: true, connected: true, accountName: a.accountName ?? null, hasDataSource: missingFor(c, true).length === 0, country: c.country };
        } catch (e) {
          body = { configured: true, connected: false, error: e instanceof MerchantError ? { code: e.code, message: e.message } : { code: 'INTERNAL', message: 'Could not reach Merchant Center' }, hasDataSource: missingFor(c, true).length === 0 };
        }
        statusCache = { at: Date.now(), body };
      }
      const b = statusCache.body;
      io.send(res, 200, owner ? { ...b, accountId: c.accountId, dataSource: c.dataSourceId ? dataSourceName(c) : null } : b);
      return true;
    }

    if (req.method === 'GET' && path === '/api/merchant/listings') {
      const all = (await io.store.list<Listing>('listings', 100)).filter((l) => l.status !== 'DELETED').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      io.send(res, 200, all.map((l) => publicListing(l, owner)));
      return true;
    }

    const one = path.match(/^\/api\/merchant\/listing\/([\w.-]{3,60})$/);
    if (one && req.method === 'GET') {
      if (!OFFER_ID.test(one[1])) { io.send(res, 404, { error: 'not found' }); return true; }
      let l = await io.store.get<Listing>('listings', one[1]);
      if (!l) { io.send(res, 404, { error: 'not found' }); return true; }
      if ((l.status === 'SUBMITTED' || l.status === 'PROCESSING') && (!l.checkedAt || Date.now() - new Date(l.checkedAt).getTime() > STALE_MS)) l = await refresh(l);
      io.send(res, 200, publicListing(l, owner));
      return true;
    }

    if (req.method === 'DELETE' && one) {
      if (!owner) { io.send(res, 401, { error: 'unauthorized' }); return true; }
      if (!needConfigured(res, true)) return true;
      const l = await io.store.get<Listing>('listings', one[1]);
      if (!l) { io.send(res, 404, { error: 'not found' }); return true; }
      try {
        if (l.status !== 'DRAFT') await getClient().request({ method: 'DELETE', path: productInputPath(c, l.offerId), query: { dataSource: dataSourceName(c) } }).catch((e) => { if (!(e instanceof MerchantError && e.code === 'MERCHANT_NOT_FOUND')) throw e; });
      } catch (e) { fail(res, e); return true; }
      await io.store.set('listings', l.offerId, { ...l, status: 'DELETED', updatedAt: new Date().toISOString() });
      await logEvent(io.store, 'owner', `Listing removed: ${l.title}`, l.offerId).catch(() => {});
      io.send(res, 200, { offerId: l.offerId, status: 'DELETED' });
      return true;
    }

    if (req.method === 'POST' && path === '/api/merchant/data-source') {
      if (!owner) { io.send(res, 401, { error: 'unauthorized' }); return true; }
      if (!needConfigured(res, false)) return true;
      try {
        const r = await ensureDataSource(getClient(), c);
        await logEvent(io.store, 'owner', r.created ? 'Merchant data source created' : 'Merchant data source found').catch(() => {});
        io.send(res, 200, { dataSourceId: r.id, created: r.created, hint: `Set MERCHANT_DATA_SOURCE_ID=${r.id} and redeploy.` });
      } catch (e) { fail(res, e); }
      return true;
    }

    if (req.method === 'POST' && path === '/api/merchant/listing') {
      if (!owner) { io.send(res, 401, { error: 'unauthorized' }); return true; }
      const b = await io.readJson(req);
      const proposalId = typeof b.proposalId === 'string' ? b.proposalId : '';
      const p = await io.store.get<Proposal>('proposals', proposalId);
      if (!p) { io.send(res, 404, { error: 'No such proposal.' }); return true; }
      if (p.status !== 'approved') { io.send(res, 409, { error: 'A person has to approve the buy before the resale is listed.' }); return true; }
      const a = await io.store.get<Analysis>('analyses', p.analysisId);
      if (!a || !a.buy) { io.send(res, 409, { error: 'The check behind this proposal is no longer available.' }); return true; }
      if (a.currency !== 'USD') { io.send(res, 422, { error: `Listings go to the ${c.country} store in USD; this product was priced in ${a.currency}.` }); return true; }
      const offered = typeof b.listPriceCents === 'number' ? b.listPriceCents : a.arbitrage?.sellReference.priceCents;
      if (!Number.isSafeInteger(offered) || (offered as number) < 1 || (offered as number) > MAX_PRICE_CENTS) { io.send(res, 400, { error: typeof b.listPriceCents === 'number' ? 'The list price has to be a whole number of cents between 1 cent and $1,000,000.' : 'This check has no second identical offer to price a resale against, so enter a list price in dollars.' , code: 'LIST_PRICE' }); return true; }
      const title = normalizeTitle(a.buy.offer.title);
      if (!title) { io.send(res, 422, { error: 'The product title is empty after cleaning.' }); return true; }
      const offerId = `l-${p.id.replace(/[^a-f0-9]/g, '').slice(0, 16) || 'x'}`;
      if (!OFFER_ID.test(offerId)) { io.send(res, 422, { error: 'This proposal cannot be listed.' }); return true; }
      const draft = { offerId, title, description: `${title}. New.`, priceCents: offered as number };
      const body = toProductInput(c, draft);
      const dryRun = b.dryRun !== false;
      const missing = missingFor(c, true);
      if (dryRun) {
        io.send(res, 200, { mode: 'preview', offerId, configured: missing.length === 0, missing, page: listingLink(c, offerId), wouldSend: { method: 'POST', path: insertPath(c), query: { dataSource: c.dataSourceId ? dataSourceName(c) : '{dataSource}' }, body } });
        return true;
      }
      if (!needConfigured(res, true)) return true;
      if ((await getLimits(io.store)).paused) { io.send(res, 423, { error: 'The agent is paused by its owner.' }); return true; }
      const hash = payloadHash(c, body);
      const existing = await io.store.get<Listing>('listings', offerId);
      if (existing && existing.hash === hash && ['SUBMITTED', 'PROCESSING', 'APPROVED'].includes(existing.status)) { io.send(res, 200, { ...publicListing(existing, true), idempotent: true }); return true; }
      const now = new Date().toISOString();
      const rec: Listing = { offerId, proposalId: p.id, analysisId: a.id, title, description: draft.description, priceCents: draft.priceCents, currency: 'USD', imageSource: a.buy.offer.thumbnail ?? null, status: 'DRAFT', issues: [], productName: null, hash, createdAt: existing?.createdAt ?? now, updatedAt: now, checkedAt: null };
      // The page has to exist before Google looks at it, so it is saved as soon as the insert is accepted.
      try {
        const r = await getClient().request<{ name?: unknown }>({ method: 'POST', path: insertPath(c), query: { dataSource: dataSourceName(c) }, body });
        const saved: Listing = { ...rec, status: 'SUBMITTED', productName: typeof r.name === 'string' ? r.name : null };
        await io.store.set('listings', offerId, saved);
        await logEvent(io.store, 'owner', `Listed on Merchant Center: ${title}`, `${usd(saved.priceCents)} · ${offerId}`).catch(() => {});
        io.send(res, existing ? 200 : 201, { ...publicListing(saved, true), idempotent: false });
      } catch (e) { fail(res, e); }
      return true;
    }

    io.send(res, 404, { error: 'not found' });
    return true;
  }

  return { handle, listingPage: (l: Listing) => listingPage(c, l), micros: centsToMicros };
}
