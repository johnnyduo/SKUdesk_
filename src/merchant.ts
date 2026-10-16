import { createSign } from 'node:crypto';
import { hashKey } from './store.ts';

// Google Merchant Center through the Merchant API v1. After a person approves a buy, the owner can list the resale in their own
// Merchant Center account. The listing points at a page on this site (see listingPage in merchant-page.ts) and is only sent
// after a preview and with the owner key. Field names follow the Merchant API reference for products_v1.

export class MerchantError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface MerchantConfig {
  saJson: string;
  accountId: string;
  dataSourceId: string;
  language: string;
  feedLabel: string;
  country: string;
  siteOrigin: string;
  base: string;
}

const DIGITS = /^\d{1,20}$/;

export function merchantConfigFrom(env: (k: string) => string | undefined): MerchantConfig {
  return {
    saJson: env('GOOGLE_SA_JSON') ?? '',
    accountId: (env('MERCHANT_ACCOUNT_ID') ?? '').trim(),
    dataSourceId: (env('MERCHANT_DATA_SOURCE_ID') ?? '').trim(),
    language: env('MERCHANT_LANGUAGE') ?? 'en',
    feedLabel: env('MERCHANT_FEED_LABEL') ?? 'US',
    country: env('MERCHANT_COUNTRY') ?? 'US',
    siteOrigin: (env('PUBLIC_SITE_ORIGIN') ?? 'https://skudesk.lol').replace(/\/+$/, ''),
    base: env('MERCHANT_API_BASE') ?? 'https://merchantapi.googleapis.com',
  };
}

/** Names (never values) of what is still needed. The data source is only needed to publish. */
export function missingFor(c: MerchantConfig, needDataSource: boolean): string[] {
  const out: string[] = [];
  if (!c.saJson) out.push('GOOGLE_SA_JSON');
  if (!DIGITS.test(c.accountId)) out.push('MERCHANT_ACCOUNT_ID');
  if (needDataSource && !DIGITS.test(c.dataSourceId)) out.push('MERCHANT_DATA_SOURCE_ID');
  return out;
}

export const dataSourceName = (c: MerchantConfig): string => `accounts/${c.accountId}/dataSources/${c.dataSourceId}`;

// ── service-account token ──
const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/content';

export function parseServiceAccount(raw: string): { client_email: string; private_key: string } {
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw); } catch { throw new MerchantError(503, 'NOT_CONFIGURED', 'GOOGLE_SA_JSON is not valid JSON'); }
  if (typeof o !== 'object' || o === null || typeof o.client_email !== 'string' || typeof o.private_key !== 'string') throw new MerchantError(503, 'NOT_CONFIGURED', 'GOOGLE_SA_JSON lacks client_email or private_key');
  return { client_email: o.client_email, private_key: o.private_key.replace(/\\n/g, '\n') };
}

export function signJwt(sa: { client_email: string; private_key: string }, nowSec: number): string {
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }))}`;
  try {
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url')}`;
  } catch {
    throw new MerchantError(503, 'NOT_CONFIGURED', 'the service account private_key could not be used');
  }
}

// ── client ──
export interface ClientOpts { config: MerchantConfig; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number }
export interface Req { method: 'GET' | 'POST' | 'DELETE'; path: string; query?: Record<string, string>; body?: unknown }
export interface MerchantClient { request<T>(r: Req): Promise<T> }

const NOT_REGISTERED = /is not registered with the merchant account/i;
const FIELD = /^[\w.[\]]{1,80}$/;

function googleText(body: unknown): string {
  const m = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === 'string' ? m : '';
}

function violationFields(body: unknown): string[] {
  const out: string[] = [];
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  for (const d of Array.isArray(details) ? details : []) {
    for (const v of Array.isArray((d as { fieldViolations?: unknown })?.fieldViolations) ? (d as { fieldViolations: unknown[] }).fieldViolations : []) {
      const f = (v as { field?: unknown })?.field;
      if (typeof f === 'string' && FIELD.test(f) && !out.includes(f) && out.length < 5) out.push(f);
    }
  }
  return out;
}

/** A final Google error as one of ours, with a fixed message: upstream text can quote the request, so it is never passed on. */
export function mapGoogleError(status: number, body: unknown): MerchantError {
  if (NOT_REGISTERED.test(googleText(body))) return new MerchantError(502, 'MERCHANT_NOT_REGISTERED', 'This Google Cloud project is not registered with the Merchant Center account yet');
  if (status === 401 || status === 403) return new MerchantError(502, 'MERCHANT_UNAUTHORIZED', `Merchant Center refused the credentials (HTTP ${status}). The service account must be an Admin user on the account`);
  if (status === 404) return new MerchantError(404, 'MERCHANT_NOT_FOUND', 'Not found in Merchant Center');
  if (status === 429) return new MerchantError(503, 'MERCHANT_QUOTA', 'Merchant Center quota used up, try again later');
  if (status === 400) { const f = violationFields(body); return new MerchantError(422, 'MERCHANT_INVALID_PRODUCT', `Merchant Center rejected the listing${f.length ? ` (fields: ${f.join(', ')})` : ''}`); }
  return new MerchantError(502, 'MERCHANT_UPSTREAM', `Merchant Center error (HTTP ${status})`);
}

export function createClient(o: ClientOpts): MerchantClient {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  let token: { value: string; until: number } | null = null;

  async function accessToken(force: boolean): Promise<string> {
    if (!force && token && token.until > now()) return token.value;
    const sa = parseServiceAccount(o.config.saJson);
    let res: Response;
    try {
      res = await f(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(sa, Math.floor(now() / 1000)) }).toString(), signal: AbortSignal.timeout(10_000) });
    } catch { throw new MerchantError(502, 'MERCHANT_UPSTREAM', 'Google sign-in did not answer'); }
    if (!res.ok) throw new MerchantError(502, 'MERCHANT_UNAUTHORIZED', `Google sign-in refused the service account (HTTP ${res.status})`);
    const b = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof b?.access_token !== 'string' || typeof b.expires_in !== 'number') throw new MerchantError(502, 'MERCHANT_UNAUTHORIZED', 'Google sign-in answered with something unexpected');
    token = { value: b.access_token, until: now() + Math.max(60, b.expires_in - 300) * 1000 };
    return token.value;
  }

  return {
    async request<T>(r: Req): Promise<T> {
      const url = new URL(o.config.base.replace(/\/+$/, '') + r.path);
      for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, v);
      let attempt = 0, refreshed = false, force = false;
      for (;;) {
        const t = await accessToken(force);
        force = false;
        const headers: Record<string, string> = { authorization: `Bearer ${t}`, accept: 'application/json' };
        if (r.body !== undefined) headers['content-type'] = 'application/json';
        let res: Response | null = null;
        try { res = await f(url, { method: r.method, headers, body: r.body === undefined ? undefined : JSON.stringify(r.body), signal: AbortSignal.timeout(10_000) }); } catch { res = null; }
        if (res?.ok) {
          const text = await res.text().catch(() => '');
          if (r.method === 'DELETE' || res.status === 204) return {} as T;
          try { const v = JSON.parse(text); if (typeof v === 'object' && v !== null) return v as T; } catch { /* falls through */ }
          throw new MerchantError(502, 'MERCHANT_UPSTREAM', `Merchant Center sent an unreadable answer (HTTP ${res.status})`);
        }
        const status = res?.status ?? 0;
        const body = res ? await res.json().catch(() => ({})) : {};
        if (status === 401 && !refreshed && !NOT_REGISTERED.test(googleText(body))) { refreshed = true; force = true; continue; }
        if ((status === 0 || status === 429 || status >= 500) && attempt < 3) { await sleep(Math.min(4000, 250 * 2 ** attempt) + Math.floor(random() * 250)); attempt++; continue; }
        if (status === 0) throw new MerchantError(504, 'MERCHANT_UPSTREAM', 'Merchant Center did not answer in time');
        throw mapGoogleError(status, body);
      }
    },
  };
}

// ── product mapping ──
const PROMO = /\b(free shipping|best price|buy now|limited time|hot deal|cheapest|sale|discount)\b/gi;

/** Plain, capped listing title: control characters and promo phrases out, shouting lower-cased, at most 150 characters. */
export function normalizeTitle(raw: string): string {
  let t = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(PROMO, ' ').replace(/!+/g, ' ').replace(/\s+/g, ' ').trim();
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 8 && letters === letters.toUpperCase()) t = t.toLowerCase().replace(/(^|\s)([a-z])/g, (_m, sp: string, ch: string) => sp + ch.toUpperCase());
  const cps = Array.from(t);
  if (cps.length > 150) {
    let cut = cps.slice(0, 150).join('');
    const sp = cut.lastIndexOf(' ');
    if (sp >= 100) cut = cut.slice(0, sp);
    t = cut.trim();
  }
  return t;
}

export const centsToMicros = (cents: number): string => (BigInt(cents) * 10000n).toString();

export interface Listing {
  offerId: string;
  proposalId: string;
  analysisId: string;
  title: string;
  description: string;
  priceCents: number;
  currency: 'USD';
  imageSource: string | null;
  status: 'DRAFT' | 'SUBMITTED' | 'PROCESSING' | 'APPROVED' | 'DISAPPROVED' | 'DELETED';
  issues: { code: string; severity: string; description: string }[];
  productName: string | null;
  hash: string | null;
  createdAt: string;
  updatedAt: string;
  checkedAt: string | null;
}

export const listingLink = (c: MerchantConfig, offerId: string): string => `${c.siteOrigin}/p/${offerId}/`;
export const listingImage = (c: MerchantConfig, offerId: string): string => `${c.siteOrigin}/p/${offerId}/image`;

export function toProductInput(c: MerchantConfig, l: Pick<Listing, 'offerId' | 'title' | 'description' | 'priceCents'>): Record<string, unknown> {
  return {
    offerId: l.offerId,
    contentLanguage: c.language,
    feedLabel: c.feedLabel,
    productAttributes: {
      title: l.title,
      description: l.description,
      link: listingLink(c, l.offerId),
      imageLink: listingImage(c, l.offerId),
      price: { amountMicros: centsToMicros(l.priceCents), currencyCode: 'USD' },
      availability: 'IN_STOCK',
      condition: 'NEW',
      identifierExists: false,
    },
  };
}

// The encoded product id Google uses in paths: unpadded base64url of "language~feedLabel~offerId".
export const encodeProductId = (lang: string, label: string, offerId: string): string => Buffer.from(`${lang}~${label}~${offerId}`).toString('base64url');
export const insertPath = (c: MerchantConfig): string => `/products/v1/accounts/${c.accountId}/productInputs:insert`;
export const productInputPath = (c: MerchantConfig, offerId: string): string => `/products/v1/accounts/${c.accountId}/productInputs/${encodeProductId(c.language, c.feedLabel, offerId)}`;
export const productPath = (c: MerchantConfig, offerId: string): string => `/products/v1/accounts/${c.accountId}/products/${encodeProductId(c.language, c.feedLabel, offerId)}`;
export const payloadHash = (c: MerchantConfig, body: unknown): string => hashKey(JSON.stringify({ ds: dataSourceName(c), body }));

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** From the processed product: approved if any destination approves the country, disapproved if one disapproves it, otherwise still processing. */
export function deriveStatus(product: unknown, country: string): { status: 'PROCESSING' | 'APPROVED' | 'DISAPPROVED'; issues: Listing['issues'] } {
  const ps = (product as { productStatus?: Record<string, unknown> } | null)?.productStatus ?? {};
  const dests = Array.isArray(ps.destinationStatuses) ? (ps.destinationStatuses as Record<string, unknown>[]) : [];
  const raw = Array.isArray(ps.itemLevelIssues) ? (ps.itemLevelIssues as Record<string, unknown>[]) : [];
  const issues = raw
    .filter((i) => { const c = strs(i.applicableCountries); return c.length === 0 || c.includes(country); })
    .map((i) => ({ code: str(i.code) ?? 'unknown', severity: str(i.severity) ?? 'UNKNOWN', description: (str(i.description) ?? '').slice(0, 300) }))
    .slice(0, 10);
  if (dests.some((d) => strs(d.approvedCountries).includes(country))) return { status: 'APPROVED', issues };
  if (dests.some((d) => strs(d.disapprovedCountries).includes(country)) || issues.some((i) => i.severity === 'DISAPPROVED')) return { status: 'DISAPPROVED', issues };
  return { status: 'PROCESSING', issues };
}

// ── data source: find or create the primary source the API writes to ──
export const DATA_SOURCE_NAME = 'SKUdesk API';

export async function ensureDataSource(client: MerchantClient, c: MerchantConfig): Promise<{ id: string; created: boolean }> {
  const list = await client.request<{ dataSources?: Record<string, unknown>[] }>({ method: 'GET', path: `/datasources/v1/accounts/${c.accountId}/dataSources`, query: { pageSize: '1000' } });
  for (const ds of list.dataSources ?? []) {
    const pp = ds.primaryProductDataSource as Record<string, unknown> | undefined;
    const name = str(ds.name) ?? '';
    const id = /\/dataSources\/(\d+)$/.exec(name)?.[1];
    if (pp && pp.contentLanguage === c.language && pp.feedLabel === c.feedLabel && (ds.input === 'API' || ds.displayName === DATA_SOURCE_NAME) && id) return { id, created: false };
  }
  const made = await client.request<{ name?: string }>({ method: 'POST', path: `/datasources/v1/accounts/${c.accountId}/dataSources`, body: { displayName: DATA_SOURCE_NAME, primaryProductDataSource: { contentLanguage: c.language, feedLabel: c.feedLabel, countries: [c.country] } } });
  const id = /\/dataSources\/(\d+)$/.exec(made.name ?? '')?.[1];
  if (!id) throw new MerchantError(502, 'MERCHANT_UPSTREAM', 'Merchant Center did not return the new data source');
  return { id, created: true };
}
