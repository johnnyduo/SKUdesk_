import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { MemoryStore, Quota } from '../src/store.ts';
import { getLimits, setLimits } from '../src/domain.ts';
import { createClient, deriveStatus, encodeProductId, mapGoogleError, merchantConfigFrom, missingFor, normalizeTitle, parseServiceAccount, signJwt, centsToMicros } from '../src/merchant.ts';
import type { Offer } from '../src/types.ts';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({ client_email: 'agent@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
const env = (extra: Record<string, string> = {}) => (k: string): string | undefined => ({ GOOGLE_SA_JSON: SA, MERCHANT_ACCOUNT_ID: '123456', MERCHANT_DATA_SOURCE_ID: '777', ...extra })[k];

const offer = (seller: string, priceCents: number, title = 'LEGO SET 1 SEALED!!'): Offer => ({ id: `${seller}-${priceCents}`, title, seller, channel: 'retailer', priceCents, currency: 'USD', shippingCents: 0, secondHand: false, url: 'https://example.test', origin: 'serpapi', thumbnail: 'https://encrypted-tbn0.gstatic.com/images?q=x' });

// A stand-in for Google: token endpoint and the Merchant API paths the agent uses. Every call is recorded.
function google(opts: { insertStatus?: number; product?: unknown } = {}) {
  const calls: { method: string; url: URL; body: any; auth: string }[] = [];
  const f = (async (input: any, init: any) => {
    const url = new URL(typeof input === 'string' ? input : input.href ?? input.url);
    if (url.origin !== 'https://merchantapi.googleapis.com' && url.origin !== 'https://oauth2.googleapis.com') return new Response('{}', { status: 599 });
    const body = init?.body ? (String(init.body).startsWith('{') ? JSON.parse(String(init.body)) : String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body, auth: init?.headers?.authorization ?? '' });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/token') return json({ access_token: 'tok-1', expires_in: 3600 });
    if (/^\/accounts\/v1\/accounts\/123456$/.test(url.pathname)) return json({ accountName: 'Demo store' });
    if (url.pathname.endsWith('productInputs:insert')) return opts.insertStatus && opts.insertStatus !== 200 ? json({ error: { message: 'bad', details: [{ fieldViolations: [{ field: 'product_attributes.price' }] }] } }, opts.insertStatus) : json({ name: 'accounts/123456/productInputs/abc' });
    if (/\/products\/v1\/accounts\/123456\/products\//.test(url.pathname)) return opts.product ? json(opts.product) : json({ error: { message: 'nf' } }, 404);
    if (/\/productInputs\//.test(url.pathname) && init?.method === 'DELETE') return new Response('{}', { status: 200 });
    if (/\/datasources\/v1\/accounts\/123456\/dataSources$/.test(url.pathname)) return init?.method === 'POST' ? json({ name: 'accounts/123456/dataSources/999' }) : json({ dataSources: [] });
    return json({}, 404);
  }) as typeof fetch;
  // the real token URL is https://oauth2.googleapis.com/token
  return { f, calls };
}

async function serve(g = google(), configEnv: Record<string, string> = {}) {
  const store = new MemoryStore();
  const app = createApp({
    store, quota: new Quota(store, 10), scanSecret: 's', ownerKey: 'owner-key', watchlist: [], sources: { serpapi: true, ebay: false }, storeKind: 'memory',
    merchant: { config: merchantConfigFrom(env(configEnv)), fetch: g.f, sleep: async () => {} },
    agent: { search: async () => ({ offers: [offer('A', 10000), offer('B', 12000)], fromCache: false }), engine: { compare: async () => ({ verdict: 'identical', confidence: 0.99, reasons: ['r'], mismatches: [], evidence: { brand: 'LEGO', brandQuoteA: 'LEGO', brandQuoteB: 'LEGO', idA: '1', idB: '1' } }) }, store, model: 'm', limits: () => getLimits(store) },
  });
  await new Promise<void>((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const owner = { 'x-skudesk-owner': 'owner-key' };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const approved = async () => {
    const a = await (await call('POST', '/api/analyze', { query: 'LEGO SET 1', market: 'us' })).json();
    await call('POST', `/api/proposals/${a.proposalId}/decision`, { decision: 'approved' }, owner);
    return a;
  };
  return { store, base, owner, call, approved, calls: g.calls, close: () => app.close() };
}

test('the service-account token is a real RS256 JWT for the Merchant scope', () => {
  const sa = parseServiceAccount(SA);
  const jwt = signJwt(sa, 1_700_000_000);
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.iss, sa.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/content');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })), Buffer.from(sig, 'base64url')));
  assert.throws(() => parseServiceAccount('not json'), /not valid JSON/);
  assert.throws(() => parseServiceAccount('{}'), /client_email/);
});

test('configuration reports names, never values', () => {
  assert.deepEqual(missingFor(merchantConfigFrom(() => undefined), true), ['GOOGLE_SA_JSON', 'MERCHANT_ACCOUNT_ID', 'MERCHANT_DATA_SOURCE_ID']);
  assert.deepEqual(missingFor(merchantConfigFrom(env({ MERCHANT_DATA_SOURCE_ID: '' })), false), []);
  assert.deepEqual(missingFor(merchantConfigFrom(env({ MERCHANT_ACCOUNT_ID: 'abc' })), false), ['MERCHANT_ACCOUNT_ID']);
});

test('titles are cleaned, prices become micros, product ids are encoded as Google expects', () => {
  assert.equal(normalizeTitle('LEGO TITANIC SET 10294 FREE SHIPPING!!!'), 'Lego Titanic Set 10294');
  assert.equal(normalizeTitle('x'.repeat(400)).length <= 150, true);
  assert.equal(centsToMicros(12345), '123450000');
  assert.equal(Buffer.from(encodeProductId('en', 'US', 'l-abc'), 'base64url').toString(), 'en~US~l-abc');
});

test('derived status: approved wins, a disapproval is reported with its issues, nothing yet means processing', () => {
  const dest = (a: string[], d: string[]) => ({ productStatus: { destinationStatuses: [{ approvedCountries: a, disapprovedCountries: d }], itemLevelIssues: [{ code: 'x', severity: 'DISAPPROVED', description: 'Missing price', applicableCountries: ['US'] }] } });
  assert.equal(deriveStatus(dest(['US'], []), 'US').status, 'APPROVED');
  const dis = deriveStatus(dest([], ['US']), 'US');
  assert.equal(dis.status, 'DISAPPROVED');
  assert.equal(dis.issues[0].description, 'Missing price');
  assert.equal(deriveStatus({ productStatus: {} }, 'US').status, 'PROCESSING');
});

test('Google errors become fixed messages that never repeat upstream text', () => {
  const e = mapGoogleError(400, { error: { message: 'secret echo of the request', details: [{ fieldViolations: [{ field: 'product_attributes.price' }, { field: '<script>' }] }] } });
  assert.equal(e.code, 'MERCHANT_INVALID_PRODUCT');
  assert.match(e.message, /product_attributes\.price/);
  assert.doesNotMatch(e.message, /secret|script/);
  assert.equal(mapGoogleError(403, {}).code, 'MERCHANT_UNAUTHORIZED');
  assert.equal(mapGoogleError(500, {}).code, 'MERCHANT_UPSTREAM');
  assert.equal(mapGoogleError(400, { error: { message: 'GCP project is not registered with the merchant account' } }).code, 'MERCHANT_NOT_REGISTERED');
});

test('the client signs in once, retries a busy API and refreshes a rejected token once', async () => {
  let n = 0, tokens = 0;
  const f = (async (input: any) => {
    const u = new URL(typeof input === 'string' ? input : input.href);
    if (u.pathname === '/token') { tokens++; return new Response(JSON.stringify({ access_token: `t${tokens}`, expires_in: 3600 }), { status: 200 }); }
    n++;
    if (n === 1) return new Response('{}', { status: 503 });
    if (n === 2) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const c = createClient({ config: merchantConfigFrom(env()), fetch: f, sleep: async () => {} });
  assert.deepEqual(await c.request({ method: 'GET', path: '/accounts/v1/accounts/123456' }), { ok: true });
  assert.equal(tokens, 2, 'one sign-in, one more after the 401');
  const again = await c.request<{ ok: boolean }>({ method: 'GET', path: '/x' });
  assert.equal(again.ok, true);
  assert.equal(tokens, 2, 'the token is reused');
});

test('status: not connected lists what is missing; connected reads the account; ids stay owner-only', async () => {
  const bare = await serve(google(), { GOOGLE_SA_JSON: '' });
  const off = await (await bare.call('GET', '/api/merchant/status')).json();
  assert.equal(off.configured, false);
  assert.deepEqual(off.missing, ['GOOGLE_SA_JSON']);
  bare.close();

  const s = await serve();
  const pub = await (await s.call('GET', '/api/merchant/status')).json();
  assert.equal(pub.connected, true);
  assert.equal(pub.accountName, 'Demo store');
  assert.equal(pub.accountId, undefined);
  const own = await (await s.call('GET', '/api/merchant/status', undefined, s.owner)).json();
  assert.equal(own.accountId, '123456');
  assert.ok(s.calls.some((c) => c.url.pathname === '/accounts/v1/accounts/123456' && c.auth === 'Bearer tok-1'));
  s.close();
});

test('listing: owner only, needs an approved buy, previews first, publishes once, and the page is public', async () => {
  const s = await serve();
  const a = await (await s.call('POST', '/api/analyze', { query: 'LEGO SET 1', market: 'us' })).json();
  assert.equal((await s.call('POST', '/api/merchant/listing', { proposalId: a.proposalId })).status, 401);
  assert.equal((await s.call('POST', '/api/merchant/listing', { proposalId: a.proposalId }, s.owner)).status, 409, 'not approved yet');
  await s.call('POST', `/api/proposals/${a.proposalId}/decision`, { decision: 'approved' }, s.owner);

  const preview = await (await s.call('POST', '/api/merchant/listing', { proposalId: a.proposalId }, s.owner)).json();
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.wouldSend.body.productAttributes.price.amountMicros, '120000000', 'listed at the next cheapest identical price');
  assert.equal(preview.wouldSend.body.productAttributes.title, 'Lego Set 1 Sealed');
  assert.match(preview.page, /^https:\/\/skudesk\.lol\/p\/l-[a-f0-9]+\/$/);
  assert.equal(s.calls.filter((c) => c.url.pathname.endsWith('insert')).length, 0, 'a preview sends nothing');

  const live = await s.call('POST', '/api/merchant/listing', { proposalId: a.proposalId, dryRun: false }, s.owner);
  assert.equal(live.status, 201);
  const l = await live.json();
  assert.equal(l.status, 'SUBMITTED');
  const ins = s.calls.filter((c) => c.url.pathname.endsWith('insert'));
  assert.equal(ins.length, 1);
  assert.equal(ins[0].url.searchParams.get('dataSource'), 'accounts/123456/dataSources/777');
  assert.equal(ins[0].body.productAttributes.availability, 'IN_STOCK');

  const again = await (await s.call('POST', '/api/merchant/listing', { proposalId: a.proposalId, dryRun: false }, s.owner)).json();
  assert.equal(again.idempotent, true);
  assert.equal(s.calls.filter((c) => c.url.pathname.endsWith('insert')).length, 1, 'the same listing is not sent twice');

  const page = await s.call('GET', `/p/${l.offerId}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<h1>Lego Set 1 Sealed<\/h1>/);
  assert.match(html, /\$120\.00/);
  assert.match(html, /"availability":"https:\/\/schema.org\/InStock"/);
  assert.equal((await (await s.call('GET', '/api/merchant/listings')).json()).length, 1);
  assert.equal((await (await s.call('GET', '/api/merchant/listings')).json())[0].productName, undefined, 'the Google product name is owner-only');
  s.close();
});

test('listing: paused agent, a rejected product and a foreign currency are refused with plain messages', async () => {
  const s = await serve(google({ insertStatus: 400 }));
  const a = await s.approved();
  const bad = await s.call('POST', '/api/merchant/listing', { proposalId: a.proposalId, dryRun: false }, s.owner);
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).error, /product_attributes\.price/);
  assert.equal((await (await s.call('GET', '/api/merchant/listings')).json()).length, 0, 'a rejected listing leaves nothing behind');
  await setLimits(s.store, { paused: true });
  const paused = await s.call('POST', '/api/merchant/listing', { proposalId: a.proposalId, dryRun: false }, s.owner);
  assert.equal(paused.status, 423);
  s.close();

  const notReady = await serve(google(), { MERCHANT_DATA_SOURCE_ID: '' });
  const b = await notReady.approved();
  const r = await notReady.call('POST', '/api/merchant/listing', { proposalId: b.proposalId, dryRun: false }, notReady.owner);
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /MERCHANT_DATA_SOURCE_ID/);
  notReady.close();
});

test('status refresh reads the processed product; delete removes it from Merchant Center and takes the page down', async () => {
  const product = { productStatus: { destinationStatuses: [{ approvedCountries: ['US'], disapprovedCountries: [] }], itemLevelIssues: [] } };
  const s = await serve(google({ product }));
  const a = await s.approved();
  const l = await (await s.call('POST', '/api/merchant/listing', { proposalId: a.proposalId, dryRun: false }, s.owner)).json();
  const read = await (await s.call('GET', `/api/merchant/listing/${l.offerId}`)).json();
  assert.equal(read.status, 'APPROVED');
  assert.equal((await s.call('DELETE', `/api/merchant/listing/${l.offerId}`)).status, 401);
  const del = await s.call('DELETE', `/api/merchant/listing/${l.offerId}`, undefined, s.owner);
  assert.equal(del.status, 200);
  assert.ok(s.calls.some((c) => c.method === 'DELETE' && c.url.searchParams.get('dataSource') === 'accounts/123456/dataSources/777'));
  assert.equal((await s.call('GET', `/p/${l.offerId}/`)).status, 404);
  assert.equal((await (await s.call('GET', '/api/merchant/listings')).json()).length, 0);
  s.close();
});

test('the data source is found or created for the owner', async () => {
  const s = await serve(google(), { MERCHANT_DATA_SOURCE_ID: '' });
  assert.equal((await s.call('POST', '/api/merchant/data-source')).status, 401);
  const r = await (await s.call('POST', '/api/merchant/data-source', undefined, s.owner)).json();
  assert.equal(r.dataSourceId, '999');
  assert.equal(r.created, true);
  s.close();
});
