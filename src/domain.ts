import { createHash } from 'node:crypto';
import type { Store } from './store.ts';
import type { Analysis } from './types.ts';

// Owner-controlled settings, watches, the activity log and price history. All of it lives in the same Firestore database.

export interface Limits {
  maxSpendCents: number;
  minMarginBps: number;
  paused: boolean;
  updatedAt: string;
}

export const DEFAULT_LIMITS: Limits = { maxSpendCents: 150_000, minMarginBps: 1000, paused: false, updatedAt: '' };

export async function getLimits(store: Store): Promise<Limits> {
  return { ...DEFAULT_LIMITS, ...(await store.get<Partial<Limits>>('settings', 'limits')) };
}

const intIn = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

export function parseLimitsPatch(body: Record<string, unknown>): Partial<Limits> | string {
  const patch: Partial<Limits> = {};
  if ('maxSpendCents' in body) { const v = intIn(body.maxSpendCents, 100, 10_000_000); if (v === undefined) return 'maxSpendCents must be a whole number of cents between 100 and 10,000,000'; patch.maxSpendCents = v; }
  if ('minMarginBps' in body) { const v = intIn(body.minMarginBps, 0, 20_000); if (v === undefined) return 'minMarginBps must be a whole number of basis points between 0 and 20,000'; patch.minMarginBps = v; }
  if ('paused' in body) { if (typeof body.paused !== 'boolean') return 'paused must be true or false'; patch.paused = body.paused; }
  return patch;
}

export async function setLimits(store: Store, patch: Partial<Limits>): Promise<Limits> {
  const next = { ...(await getLimits(store)), ...patch, updatedAt: new Date().toISOString() };
  await store.set('settings', 'limits', next);
  return next;
}

export interface Watch {
  id: string;
  query: string;
  market: string;
  active: boolean;
  createdAt: string;
  lastRunAt?: string;
}

export const MAX_WATCHES = 8;
export const watchId = (query: string, market: string): string => createHash('sha1').update(`${query.trim().toLowerCase()}|${market}`).digest('hex').slice(0, 12);

export async function listWatches(store: Store): Promise<Watch[]> {
  return (await store.list<Watch>('watches', 50)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addWatch(store: Store, query: string, market: string): Promise<Watch | string> {
  const all = await listWatches(store);
  const id = watchId(query, market);
  if (all.some((w) => w.id === id)) return 'That product is already being watched.';
  if (all.length >= MAX_WATCHES) return `At most ${MAX_WATCHES} watches are allowed to protect the monthly search budget.`;
  const w: Watch = { id, query: query.trim(), market, active: true, createdAt: new Date().toISOString() };
  await store.set('watches', id, w);
  return w;
}

export interface EventRow {
  id: string;
  createdAt: string;
  kind: 'analysis' | 'proposal' | 'decision' | 'scan' | 'owner';
  title: string;
  detail?: string;
}

export async function logEvent(store: Store, kind: EventRow['kind'], title: string, detail?: string): Promise<void> {
  const at = new Date();
  const id = `${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await store.set('events', id, { id, createdAt: at.toISOString(), kind, title, ...(detail ? { detail } : {}) });
}

export interface HistoryPoint {
  t: string;
  buyLandedCents: number | null;
  lowestAskCents: number | null;
  identical: number;
  considered: number;
}

export const productKey = (query: string, market: string): string => createHash('sha1').update(`${query.trim().toLowerCase()}|${market}`).digest('hex').slice(0, 14);

export async function recordHistory(store: Store, a: Analysis): Promise<void> {
  const id = productKey(a.query, a.market);
  const prev = await store.get<{ query: string; market: string; currency: string; createdAt: string; points: HistoryPoint[] }>('history', id);
  const point: HistoryPoint = {
    t: a.createdAt, buyLandedCents: a.buy?.landedCents ?? null, lowestAskCents: a.sell?.listAtCents ?? null,
    identical: a.gate.identical, considered: a.gate.considered,
  };
  const points = [...(prev?.points ?? []), point].slice(-60);
  await store.set('history', id, { query: a.query, market: a.market, currency: a.currency, createdAt: a.createdAt, points });
}
