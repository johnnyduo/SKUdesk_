import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { analyze, DEFAULT_ASSUMPTIONS, type AgentDeps } from './agent.ts';
import { MARKETS } from './serpapi.ts';
import { QuotaExceeded, type Quota, type Store } from './store.ts';
import type { Analysis, Proposal } from './types.ts';

export interface AppDeps {
  agent: AgentDeps;
  store: Store;
  quota: Quota;
  scanSecret: string;
  watchlist: { query: string; market: string }[];
  sources: { serpapi: boolean; ebay: boolean };
  storeKind: string;
  rateLimitPerMin?: number;
  evalSummary?: unknown;
}

const UI_DIR = new URL('./ui/', import.meta.url);
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', woff2: 'font/woff2', ico: 'image/x-icon',
};

// Every file under src/ui is served at its own path; "/" is index.html. Loaded once at start-up.
function loadStatic(): Map<string, { type: string; body: Buffer; cache: string }> {
  const out = new Map<string, { type: string; body: Buffer; cache: string }>();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full, `${prefix}${name}/`); continue; }
      const ext = name.split('.').pop() ?? '';
      if (!TYPES[ext]) continue;
      const immutable = ext === 'woff2' || ext === 'png' || ext === 'svg';
      out.set(`/${prefix}${name}`, { type: TYPES[ext], body: readFileSync(full), cache: immutable ? 'public, max-age=86400' : 'no-cache' });
    }
  };
  walk(UI_DIR.pathname, '');
  out.set('/', out.get('/index.html')!);
  return out;
}

const HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const QUERY_OK = /^[\p{L}\p{N} .,'&+\-#:()/]{3,80}$/u;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...HEADERS });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
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
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

const secretOk = (given: string | undefined, want: string): boolean => {
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

const summary = (a: Analysis) => ({
  id: a.id, query: a.query, market: a.market, createdAt: a.createdAt, headline: a.headline, currency: a.currency,
  verdict: a.arbitrage ? (a.arbitrage.implausible ? 'unverified' : a.arbitrage.verdict) : (a.buy ? 'no-reference' : 'none'),
  identical: a.gate.identical, considered: a.gate.considered, flagged: a.flagged?.length ?? 0,
  thumbnail: (a.buy ?? a.identical[0])?.offer.thumbnail ?? null,
  buy: a.buy ? { seller: a.buy.offer.seller, landedCents: a.buy.landedCents } : null,
  netCents: a.arbitrage?.netCents ?? null,
});

// Totals over the latest analysis of each distinct product and market, so repeats are not double counted.
export function impactOf(all: Analysis[]) {
  const latest = new Map<string, Analysis>();
  for (const a of [...all].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) latest.set(`${a.query.toLowerCase()}|${a.market}`, a);
  let listings = 0, passed = 0, rejected = 0, flagged = 0, phantomCents = 0;
  for (const a of latest.values()) {
    listings += a.gate.considered;
    passed += a.gate.identical;
    rejected += a.gate.different + a.gate.uncertain;
    for (const f of a.flagged ?? []) {
      flagged++;
      if (a.currency === 'USD') phantomCents += Math.max(0, f.referenceCents - f.offer.priceCents);
    }
  }
  return { products: latest.size, listings, passed, rejected, flagged, phantomCents };
}

export function createApp(deps: AppDeps): Server {
  const hits = new Map<string, number[]>();
  const limit = deps.rateLimitPerMin ?? 6;
  const throttled = (ip: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > limit;
  };
  const files = loadStatic();

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

      if (req.method === 'GET' && files.has(path)) {
        const f = files.get(path)!;
        res.writeHead(200, { 'content-type': f.type, 'cache-control': f.cache, ...HEADERS });
        return void res.end(f.body);
      }
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });

      if (req.method === 'GET' && path === '/api/status') {
        return send(res, 200, {
          model: deps.agent.model, store: deps.storeKind, sources: deps.sources,
          quota: { used: await deps.quota.used(), limit: deps.quota.limit },
          markets: Object.values(MARKETS).map((m) => ({ code: m.code, label: m.label, currency: m.currency })),
          defaults: DEFAULT_ASSUMPTIONS, watchlist: deps.watchlist,
        });
      }

      if (req.method === 'GET' && path === '/api/impact') return send(res, 200, impactOf(await deps.store.list<Analysis>('analyses', 300)));
      if (req.method === 'GET' && path === '/api/eval') return send(res, 200, deps.evalSummary ?? null);

      if (req.method === 'GET' && path === '/api/analyses') {
        return send(res, 200, (await deps.store.list<Analysis>('analyses', 12)).map(summary));
      }
      const one = path.match(/^\/api\/analyses\/([\w-]{3,40})$/);
      if (req.method === 'GET' && one) {
        const a = await deps.store.get<Analysis>('analyses', one[1]);
        return a ? send(res, 200, a) : send(res, 404, { error: 'not found' });
      }

      if (req.method === 'POST' && path === '/api/analyze') {
        if (throttled(ip)) return send(res, 429, { error: 'Too many requests. Try again in a minute.' });
        const body = await readJson(req);
        const query = typeof body.query === 'string' ? body.query.trim() : '';
        const market = typeof body.market === 'string' ? body.market : 'us';
        if (!QUERY_OK.test(query)) return send(res, 400, { error: 'Enter a product name or set number (3 to 80 characters).' });
        if (!MARKETS[market]) return send(res, 400, { error: 'Unknown market.' });
        if (String(req.headers.accept ?? '').includes('application/x-ndjson')) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', ...HEADERS });
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
      }

      if (req.method === 'GET' && path === '/api/proposals') {
        return send(res, 200, await deps.store.list<Proposal>('proposals', 20));
      }
      const dec = path.match(/^\/api\/proposals\/([\w-]{3,40})\/decision$/);
      if (req.method === 'POST' && dec) {
        const body = await readJson(req);
        if (body.decision !== 'approved' && body.decision !== 'rejected') return send(res, 400, { error: 'decision must be approved or rejected' });
        const p = await deps.store.get<Proposal>('proposals', dec[1]);
        if (!p) return send(res, 404, { error: 'not found' });
        if (p.status !== 'pending') return send(res, 409, { error: `already ${p.status}`, proposal: p });
        const next: Proposal = { ...p, status: body.decision, decidedAt: new Date().toISOString() };
        await deps.store.set('proposals', p.id, next);
        return send(res, 200, next);
      }

      if (req.method === 'POST' && path === '/api/jobs/scan') {
        if (!secretOk(String(req.headers['x-skudesk-secret'] ?? ''), deps.scanSecret)) return send(res, 401, { error: 'unauthorized' });
        const done: ReturnType<typeof summary>[] = [];
        const failed: { query: string; error: string }[] = [];
        for (const w of deps.watchlist) {
          try {
            done.push(summary(await analyze({ query: w.query, market: w.market, fresh: true }, deps.agent)));
          } catch (e) {
            failed.push({ query: w.query, error: e instanceof Error ? e.message : String(e) });
          }
        }
        const record = { id: `scan-${Date.now().toString(36)}`, createdAt: new Date().toISOString(), done, failed };
        await deps.store.set('scans', record.id, record);
        return send(res, failed.length && !done.length ? 502 : 200, record);
      }
      if (req.method === 'GET' && path === '/api/scans') return send(res, 200, await deps.store.list('scans', 5));

      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
    }
  });
}
