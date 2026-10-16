import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { analyze, DEFAULT_ASSUMPTIONS, type AgentDeps } from './agent.ts';
import { arbitrage } from './economics.ts';
import { addWatch, getLimits, listWatches, logEvent, parseLimitsPatch, productKey, setLimits, type EventRow, type HistoryPoint, type Watch } from './domain.ts';
import { clientIp, imageUrlOk, isOwner, RateLimiter, safeEq, SECURITY_HEADERS } from './security.ts';
import { MARKETS } from './serpapi.ts';
import { loadSite, serveStatic } from './static.ts';
import { hashKey, QuotaExceeded, type Quota, type Store } from './store.ts';
import type { Analysis, Proposal } from './types.ts';

export interface AppDeps {
  agent: AgentDeps;
  store: Store;
  quota: Quota;
  scanSecret: string;
  ownerKey?: string;
  edgeSecret?: string;
  watchlist: { query: string; market: string }[];
  sources: { serpapi: boolean; ebay: boolean };
  storeKind: string;
  evalSummary?: unknown;
  siteDir?: string;
  scanMax?: number;
  analyzePerMin?: number;
  maxConcurrent?: number;
}

const QUERY_OK = /^[\p{L}\p{N} .,'&+\-#:()/]{3,80}$/u;
const ID_OK = /^[\w-]{3,40}$/;

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

export const summary = (a: Analysis) => ({
  id: a.id, query: a.query, market: a.market, createdAt: a.createdAt, headline: a.headline, currency: a.currency,
  verdict: a.arbitrage ? (a.arbitrage.implausible ? 'unverified' : a.arbitrage.verdict) : (a.buy ? 'no-reference' : 'none'),
  identical: a.gate.identical, considered: a.gate.considered, flagged: a.flagged?.length ?? 0,
  thumbnail: (a.buy ?? a.identical[0])?.offer.thumbnail ?? null,
  buy: a.buy ? { seller: a.buy.offer.seller, landedCents: a.buy.landedCents } : null,
  netCents: a.arbitrage?.netCents ?? null,
  marginBps: a.arbitrage?.marginBps ?? null,
  proposalId: a.proposalId,
});

const publicProposal = (p: Proposal): Omit<Proposal, 'tokenHash'> => {
  const { tokenHash: _omit, ...rest } = p;
  return rest;
};

const latestPerProduct = (all: Analysis[]): Analysis[] => {
  const latest = new Map<string, Analysis>();
  for (const a of [...all].filter((x) => !x.degraded).sort((x, y) => x.createdAt.localeCompare(y.createdAt))) latest.set(`${a.query.toLowerCase()}|${a.market}`, a);
  return [...latest.values()].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
};

// Totals over the latest analysis of each distinct product and market, so repeats are not double counted.
export function impactOf(all: Analysis[]) {
  const latest = latestPerProduct(all);
  let listings = 0, passed = 0, rejected = 0, flagged = 0, phantomCents = 0;
  for (const a of latest) {
    listings += a.gate.considered;
    passed += a.gate.identical;
    rejected += a.gate.different + a.gate.uncertain;
    for (const f of a.flagged ?? []) {
      flagged++;
      if (a.currency === 'USD') phantomCents += Math.max(0, f.referenceCents - f.offer.priceCents);
    }
  }
  return { products: latest.length, listings, passed, rejected, flagged, phantomCents };
}

const wholeCents = (v: unknown, max = 1_000_000_000): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null);

export function createApp(deps: AppDeps): Server {
  const ownerKey = deps.ownerKey ?? '';
  const edgeSecret = deps.edgeSecret ?? '';
  const site = loadSite(deps.siteDir ?? new URL('../web/dist/', import.meta.url).pathname);
  const analyzeMin = new RateLimiter(deps.analyzePerMin ?? 6, 60_000);
  const analyzeDay = new RateLimiter(60, 24 * 3_600_000);
  const decideMin = new RateLimiter(20, 60_000);
  const imgMin = new RateLimiter(240, 60_000);
  const readMin = new RateLimiter(240, 60_000);
  const ownerMin = new RateLimiter(20, 60_000);
  const imgCache = new Map<string, { type: string; body: Buffer }>();
  let running = 0;
  const maxRunning = deps.maxConcurrent ?? 3;

  const scanWatches = async (): Promise<{ query: string; market: string; id?: string }[]> => {
    const stored = (await listWatches(deps.store)).filter((w) => w.active);
    const seen = new Set(stored.map((w) => `${w.query.toLowerCase()}|${w.market}`));
    const extra = deps.watchlist.filter((w) => !seen.has(`${w.query.toLowerCase()}|${w.market}`));
    return [...stored.map((w) => ({ query: w.query, market: w.market, id: w.id })), ...extra].slice(0, deps.scanMax ?? 3);
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const ip = clientIp(req, edgeSecret);
      const owner = isOwner(req, ownerKey);

      if (!path.startsWith('/api/') && path !== '/health' && serveStatic(site, req, res, path)) return;
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
      if (path.startsWith('/api/') && req.method === 'GET' && readMin.hit(`r:${ip}`)) return send(res, 429, { error: 'Too many requests.' });

      if (req.method === 'GET' && path === '/api/status') {
        const limits = await getLimits(deps.store);
        return send(res, 200, {
          store: deps.storeKind, sources: deps.sources,
          quota: { used: await deps.quota.used(), limit: deps.quota.limit },
          markets: Object.values(MARKETS).map((m) => ({ code: m.code, label: m.label, currency: m.currency })),
          defaults: DEFAULT_ASSUMPTIONS, limits, watchlist: deps.watchlist, ownerEnabled: Boolean(ownerKey),
        });
      }

      if (req.method === 'GET' && path === '/api/impact') return send(res, 200, impactOf(await deps.store.list<Analysis>('analyses', 300)));
      if (req.method === 'GET' && path === '/api/eval') {
        const { model: _hidden, ...rest } = (deps.evalSummary ?? {}) as Record<string, unknown>;
        return send(res, 200, deps.evalSummary ? rest : null);
      }
      if (req.method === 'GET' && path === '/api/limits') return send(res, 200, await getLimits(deps.store));
      if (req.method === 'GET' && path === '/api/events') return send(res, 200, await deps.store.list<EventRow>('events', 40));

      if (req.method === 'GET' && path === '/api/analyses') {
        const n = Math.min(Math.max(Number(url.searchParams.get('n')) || 12, 1), 100);
        return send(res, 200, (await deps.store.list<Analysis>('analyses', n)).map(summary));
      }
      const one = path.match(/^\/api\/analyses\/([\w-]{3,40})$/);
      if (req.method === 'GET' && one) {
        const a = await deps.store.get<Analysis>('analyses', one[1]);
        return a ? send(res, 200, a) : send(res, 404, { error: 'not found' });
      }

      if (req.method === 'GET' && path === '/api/products') {
        const latest = latestPerProduct(await deps.store.list<Analysis>('analyses', 300));
        const rows = await Promise.all(latest.map(async (a) => {
          const h = await deps.store.get<{ points: HistoryPoint[] }>('history', productKey(a.query, a.market));
          return { key: productKey(a.query, a.market), ...summary(a), series: (h?.points ?? []).slice(-30) };
        }));
        return send(res, 200, rows);
      }
      const lot = path.match(/^\/api\/lots\/([a-f0-9]{14})$/);
      if (req.method === 'GET' && lot) {
        const latest = latestPerProduct(await deps.store.list<Analysis>('analyses', 300)).find((a) => productKey(a.query, a.market) === lot[1]);
        if (!latest) return send(res, 404, { error: 'not found' });
        const h = await deps.store.get<{ points: HistoryPoint[] }>('history', lot[1]);
        return send(res, 200, { analysis: latest, series: h?.points ?? [] });
      }

      if (req.method === 'GET' && path === '/api/img') {
        if (imgMin.hit(`i:${ip}`)) return send(res, 429, { error: 'Too many requests.' });
        const target = imageUrlOk(url.searchParams.get('u') ?? '');
        if (!target) return send(res, 400, { error: 'image not allowed' });
        const key = target.toString();
        let hit = imgCache.get(key);
        if (!hit) {
          const up = await fetch(target, { signal: AbortSignal.timeout(5000), redirect: 'error' }).catch(() => null);
          const type = up?.headers.get('content-type') ?? '';
          if (!up?.ok || !/^image\/(png|jpe?g|webp|gif)/.test(type)) return send(res, 502, { error: 'image unavailable' });
          const body = Buffer.from(await up.arrayBuffer());
          if (body.length > 1_500_000) return send(res, 502, { error: 'image too large' });
          hit = { type, body };
          if (imgCache.size >= 300) imgCache.delete(imgCache.keys().next().value as string);
          imgCache.set(key, hit);
        }
        res.writeHead(200, { 'content-type': hit.type, 'cache-control': 'public, max-age=86400', ...SECURITY_HEADERS });
        return void res.end(hit.body);
      }

      if (req.method === 'POST' && path === '/api/simulate') {
        const b = await readJson(req);
        const buy = wholeCents(b.buyCents), ship = wholeCents(b.shippingCents), sell = wholeCents(b.sellCents);
        if (buy === null || ship === null || sell === null || buy === 0 || sell === 0) return send(res, 400, { error: 'buyCents, shippingCents and sellCents must be whole numbers of cents.' });
        const d = DEFAULT_ASSUMPTIONS;
        const limits = await getLimits(deps.store);
        const r = arbitrage(
          { priceCents: buy, shippingCents: ship, dutyBps: 0, vatBps: wholeCents(b.taxBps, 10_000) ?? d.buyTaxBps, paymentFeeBps: 0 },
          { sellCents: sell, marketplaceFeeBps: wholeCents(b.marketplaceFeeBps, 10_000) ?? d.marketplaceFeeBps, outboundShippingCents: wholeCents(b.outboundShippingCents) ?? d.outboundShippingCents, returnReserveBps: wholeCents(b.returnReserveBps, 10_000) ?? d.returnReserveBps },
          limits.minMarginBps);
        return send(res, 200, { ...r, minMarginBps: limits.minMarginBps, withinSpendLimit: r.landedCents <= limits.maxSpendCents, maxSpendCents: limits.maxSpendCents });
      }

      if (req.method === 'POST' && path === '/api/analyze') {
        if (analyzeMin.hit(`a:${ip}`) || analyzeDay.hit(`d:${ip}`)) return send(res, 429, { error: 'Too many requests. Try again in a minute.' });
        if (running >= maxRunning) return send(res, 503, { error: 'The desk is busy. Try again in a moment.' });
        const body = await readJson(req);
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        const market = typeof body.market === 'string' ? body.market : 'us';
        if (!QUERY_OK.test(query)) return send(res, 400, { error: 'Enter a product name or set number (3 to 80 characters).' });
        if (!MARKETS[market]) return send(res, 400, { error: 'Unknown market.' });
        running++;
        try {
          if (String(req.headers.accept ?? '').includes('application/x-ndjson')) {
            res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', ...SECURITY_HEADERS });
            try {
              await analyze({ query, market }, deps.agent, (ev) => res.write(JSON.stringify(ev) + '\n'));
            } catch (e) {
              const message = e instanceof QuotaExceeded ? 'The monthly search budget for this demo is used up. Cached results still work.' : 'The analysis failed upstream. Nothing was changed.';
              if (!(e instanceof QuotaExceeded)) console.error('analyze failed', e);
              res.write(JSON.stringify({ type: 'error', message }) + '\n');
            }
            return void res.end();
          }
          try {
            return send(res, 200, await analyze({ query, market }, deps.agent));
          } catch (e) {
            if (e instanceof QuotaExceeded) return send(res, 429, { error: 'The monthly search budget for this demo is used up. Cached results still work.' });
            console.error('analyze failed', e);
            return send(res, 502, { error: 'The analysis failed upstream. Nothing was changed.' });
          }
        } finally {
          running--;
        }
      }

      if (req.method === 'GET' && path === '/api/proposals') {
        return send(res, 200, (await deps.store.list<Proposal>('proposals', 40)).map(publicProposal));
      }
      const dec = path.match(/^\/api\/proposals\/([\w-]{3,40})\/decision$/);
      if (req.method === 'POST' && dec) {
        if (decideMin.hit(`p:${ip}`)) return send(res, 429, { error: 'Too many requests.' });
        const body = await readJson(req);
        if (body.decision !== 'approved' && body.decision !== 'rejected') return send(res, 400, { error: 'decision must be approved or rejected' });
        const p = await deps.store.get<Proposal>('proposals', dec[1]);
        if (!p) return send(res, 404, { error: 'not found' });
        const token = typeof body.token === 'string' ? body.token : '';
        const holdsToken = Boolean(p.tokenHash) && safeEq(hashKey(`token|${token}`), p.tokenHash);
        if (!owner && !holdsToken) return send(res, 403, { error: 'Only the person who ran this check, or the owner, can decide it.' });
        if (p.status !== 'pending') return send(res, 409, { error: `already ${p.status}`, proposal: publicProposal(p) });
        if ((await getLimits(deps.store)).paused) return send(res, 423, { error: 'The agent is paused by its owner.' });
        if (p.blockedReason && body.decision === 'approved') return send(res, 409, { error: p.blockedReason, proposal: publicProposal(p) });
        const next: Proposal = { ...p, status: body.decision, decidedAt: new Date().toISOString() };
        await deps.store.set('proposals', p.id, next);
        await logEvent(deps.store, 'decision', `${body.decision === 'approved' ? 'Approved' : 'Rejected'}: ${p.query}`, `${p.seller} at ${(p.landedCents / 100).toFixed(2)} ${p.currency} landed`).catch(() => {});
        return send(res, 200, publicProposal(next));
      }

      // ── owner-only ──
      if (path.startsWith('/api/owner') || path === '/api/limits' || path.startsWith('/api/watches') || path === '/api/jobs/scan') {
        if (req.method !== 'GET' && ownerMin.hit(`o:${ip}`)) return send(res, 429, { error: 'Too many requests.' });
      }
      if (req.method === 'GET' && path === '/api/owner/check') return owner ? send(res, 200, { owner: true }) : send(res, 401, { error: 'unauthorized' });
      if (req.method === 'PUT' && path === '/api/limits') {
        if (!owner) return send(res, 401, { error: 'unauthorized' });
        const patch = parseLimitsPatch(await readJson(req));
        if (typeof patch === 'string') return send(res, 400, { error: patch });
        const next = await setLimits(deps.store, patch);
        await logEvent(deps.store, 'owner', patch.paused === undefined ? 'Limits updated' : patch.paused ? 'Agent paused (kill switch)' : 'Agent resumed', JSON.stringify(patch)).catch(() => {});
        return send(res, 200, next);
      }
      if (req.method === 'GET' && path === '/api/watches') return send(res, 200, await listWatches(deps.store));
      if (req.method === 'POST' && path === '/api/watches') {
        if (!owner) return send(res, 401, { error: 'unauthorized' });
        const b = await readJson(req);
        const query = typeof b.query === 'string' ? b.query.trim() : '';
        const market = typeof b.market === 'string' ? b.market : 'us';
        if (!QUERY_OK.test(query) || !MARKETS[market]) return send(res, 400, { error: 'Enter a product (3 to 80 characters) and a known market.' });
        const w = await addWatch(deps.store, query, market);
        if (typeof w === 'string') return send(res, 409, { error: w });
        await logEvent(deps.store, 'owner', `Watch added: ${w.query}`, w.market).catch(() => {});
        return send(res, 201, w);
      }
      const wid = path.match(/^\/api\/watches\/([\w-]{3,40})$/);
      if (wid && (req.method === 'DELETE' || req.method === 'PATCH')) {
        if (!owner) return send(res, 401, { error: 'unauthorized' });
        const w = await deps.store.get<Watch>('watches', wid[1]);
        if (!w) return send(res, 404, { error: 'not found' });
        if (req.method === 'DELETE') {
          await deps.store.delete('watches', w.id);
          await logEvent(deps.store, 'owner', `Watch removed: ${w.query}`).catch(() => {});
          return send(res, 200, { removed: w.id });
        }
        const b = await readJson(req);
        if (typeof b.active !== 'boolean') return send(res, 400, { error: 'active must be true or false' });
        const next = { ...w, active: b.active };
        await deps.store.set('watches', w.id, next);
        return send(res, 200, next);
      }

      if (req.method === 'POST' && path === '/api/jobs/scan') {
        if (!owner && !safeEq(String(req.headers['x-skudesk-secret'] ?? ''), deps.scanSecret)) return send(res, 401, { error: 'unauthorized' });
        if ((await getLimits(deps.store)).paused) return send(res, 423, { error: 'The agent is paused by its owner.' });
        const done: ReturnType<typeof summary>[] = [];
        const failed: { query: string; error: string }[] = [];
        for (const w of await scanWatches()) {
          try {
            done.push(summary(await analyze({ query: w.query, market: w.market, fresh: true, system: true }, deps.agent)));
            if (w.id) { const cur = await deps.store.get<Watch>('watches', w.id); if (cur) await deps.store.set('watches', w.id, { ...cur, lastRunAt: new Date().toISOString() }); }
          } catch (e) {
            failed.push({ query: w.query, error: e instanceof QuotaExceeded ? 'search budget used up' : 'upstream error' });
          }
        }
        const record = { id: `scan-${Date.now().toString(36)}`, createdAt: new Date().toISOString(), done, failed };
        await deps.store.set('scans', record.id, record);
        await logEvent(deps.store, 'scan', `Scan finished: ${done.length} checked`, failed.length ? `${failed.length} failed` : undefined).catch(() => {});
        return send(res, failed.length && !done.length ? 502 : 200, record);
      }
      if (req.method === 'GET' && path === '/api/scans') return send(res, 200, await deps.store.list('scans', 5));

      if (path.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (serveStatic(site, req, res, path)) return;
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
    }
  });
}
