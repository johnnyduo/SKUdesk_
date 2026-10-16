import { arbitrage } from '../../../src/economics.ts';

// Practice rounds: a simulated order book around one product, with four paper agents that apply the same cost
// maths as the live agent (src/economics.ts). Nothing here is a real offer and no money moves.
//
// Everything is a pure function of (product profile, round number): two visitors looking at the same product
// in the same round see the same book, the same chart and the same trades. A round is ROUND_MS long.

export const ROUND_MS = 6000;
export const ROUNDS_PER_DAY = 86_400_000 / ROUND_MS;
const SPIN_UP = 1800; // rounds simulated before midnight UTC, so the chart is never empty

export const FEE_BPS = 1300;
export const RESERVE_BPS = 200;
const IMPLAUSIBLE_BPS = 5000; // a margin above 50% is "too good to be true", as in the live agent
const START_CASH_LOTS = 4;

// ── deterministic noise ──
const fnv = (s: string): number => {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); }
  return x >>> 0;
};
const u = (seed: number, n: number, k: number): number => {
  let x = (seed ^ Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};
const gauss = (seed: number, n: number, k: number): number => Math.sqrt(-2 * Math.log(Math.max(u(seed, n, k), 1e-9))) * Math.cos(2 * Math.PI * u(seed, n, k + 101));

export const roundOf = (ms: number): number => Math.floor(ms / ROUND_MS);
export const dayRound = (n: number): number => n - Math.floor(n / ROUNDS_PER_DAY) * ROUNDS_PER_DAY + 1;
export const anchorOf = (n: number): number => Math.floor(n / ROUNDS_PER_DAY) * ROUNDS_PER_DAY - SPIN_UP;

// ── product profile ──
export type Channel = 'retailer' | 'marketplace';
export interface Seller { name: string; channel: Channel; premBps: number; shipCents: number }
export interface Profile {
  key: string; symbol: string; name: string; currency: string;
  fairCents: number; retailCents: number;
  sigmaBps: number; kappa: number; amplitudeBps: number; periodRounds: number; phase: number;
  gapPerThousand: number; sellers: Seller[]; character: string; seed: number;
}
export interface ProfileInput { key: string; symbol: string; name: string; currency: string; fairCents: number; retailCents?: number | null; category?: string; offers?: number }

const SELLER_POOL: [string, Channel][] = [
  ['Best Buy', 'retailer'], ['Walmart', 'retailer'], ['Target', 'retailer'], ['Amazon', 'retailer'], ['Lazada', 'marketplace'], ['Shopee', 'marketplace'],
  ['eBay - topdeals', 'marketplace'], ['Newegg', 'retailer'], ['B&H Photo', 'retailer'], ['Mercari', 'marketplace'], ['GameStop', 'retailer'], ['Costco', 'retailer'],
];

// How each kind of product behaves: typical move per round (basis points), how many sellers, how far apart their prices are, how often a gap opens.
const CLASSES: Record<string, { sigma: number; sellers: number; spread: number; gap: number; label: string }> = {
  Accessories: { sigma: 19, sellers: 9, spread: 420, gap: 8, label: 'Fast and crowded' },
  Audio: { sigma: 14, sellers: 8, spread: 320, gap: 7, label: 'Busy' },
  Phones: { sigma: 10, sellers: 8, spread: 240, gap: 6, label: 'Steady, deep book' },
  Gaming: { sigma: 13, sellers: 7, spread: 300, gap: 7, label: 'Event driven' },
  Computing: { sigma: 8, sellers: 6, spread: 200, gap: 4, label: 'Calm' },
  Wearables: { sigma: 11, sellers: 7, spread: 280, gap: 6, label: 'Steady' },
  Sets: { sigma: 7, sellers: 5, spread: 360, gap: 4, label: 'Thin and patient' },
};

export function profileFor(p: ProfileInput): Profile {
  const seed = fnv(`${p.key}|${p.symbol}`);
  const cls = CLASSES[p.category ?? 'Sets'] ?? CLASSES.Sets;
  const wob = (k: number, lo: number, hi: number): number => lo + u(seed, 0, k) * (hi - lo);
  const count = Math.max(4, Math.min(11, p.offers ? Math.round((p.offers + cls.sellers) / 2) : cls.sellers));
  const order = SELLER_POOL.map((s, i) => ({ s, k: u(seed, i, 7) })).sort((a, b) => a.k - b.k).map((x) => x.s);
  const spread = cls.spread * wob(3, 0.8, 1.25);
  const sellers: Seller[] = order.slice(0, count).map(([name, channel], i) => ({
    name, channel,
    premBps: i === 0 ? 0 : Math.round(spread * Math.pow(i / (count - 1), 0.85) * wob(10 + i, 0.8, 1.2)),
    shipCents: u(seed, i, 20) < 0.7 ? 0 : Math.round((p.fairCents * 0.012) / 100) * 100,
  }));
  return {
    key: p.key, symbol: p.symbol, name: p.name, currency: p.currency,
    fairCents: p.fairCents, retailCents: p.retailCents ?? Math.round(p.fairCents * 1.1),
    sigmaBps: cls.sigma * wob(1, 0.85, 1.2), kappa: wob(2, 0.004, 0.011), amplitudeBps: wob(4, 40, 110),
    periodRounds: Math.round(wob(5, 1800, 5200)), phase: wob(6, 0, Math.PI * 2),
    gapPerThousand: cls.gap * wob(8, 0.85, 1.15), sellers, character: cls.label, seed,
  };
}

// ── a round's book ──
export interface BookOffer { seller: string; channel: Channel; priceCents: number; shipCents: number; landedCents: number; flagged: boolean; dip: boolean }
export interface Gap { start: number; length: number; depth: number; cls: 'shallow' | 'medium' | 'deep' | 'bait'; seller: number }
export interface Book { offers: BookOffer[]; considered: number; gap: Gap | null }

const gapAt = (p: Profile, m: number): Gap | null => {
  if (u(p.seed, m, 40) >= p.gapPerThousand / 1000) return null;
  const c = u(p.seed, m, 41), d = u(p.seed, m, 42);
  const cls: Gap['cls'] = c < 0.4 ? 'shallow' : c < 0.7 ? 'medium' : c < 0.94 ? 'deep' : 'bait';
  const depth = cls === 'shallow' ? 0.02 + d * 0.04 : cls === 'medium' ? 0.08 + d * 0.07 : cls === 'deep' ? 0.18 + d * 0.12 : 0.52 + d * 0.16;
  return { start: m, length: 3 + Math.floor(u(p.seed, m, 43) * 5), depth, cls, seller: Math.floor(u(p.seed, m, 44) * p.sellers.length) };
};

export function activeGap(p: Profile, n: number): Gap | null {
  for (let m = n; m > n - 8; m--) { const g = gapAt(p, m); if (g && n - m < g.length) return g; }
  return null;
}

export function bookAt(p: Profile, n: number, mid: number): Book {
  const gap = activeGap(p, n);
  const raw = p.sellers.map((s, i) => {
    let price = Math.round(mid * (1 + (s.premBps + gauss(p.seed, n * 31 + i, 50) * 4) / 10_000));
    const dip = gap !== null && gap.seller === i;
    if (dip) price = Math.round(mid * (1 - gap!.depth));
    return { s, price, dip };
  });
  const prices = raw.map((r) => r.price + r.s.shipCents).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const offers: BookOffer[] = raw.map(({ s, price, dip }) => {
    const landed = price + s.shipCents;
    return { seller: s.name, channel: s.channel, priceCents: price, shipCents: s.shipCents, landedCents: landed, flagged: landed < median * 0.4 || landed < p.retailCents * 0.5, dip };
  }).sort((a, b) => a.landedCents - b.landedCents);
  return { offers, considered: offers.length + 2 + Math.floor(u(p.seed, n, 60) * 4), gap };
}

export interface RoundInfo { n: number; t: number; mid: number; ask: number | null; askSeller: string; askPrice: number; askShip: number; next: number | null; identical: number; considered: number; flagged: number; gap: Gap | null }

const outbound = (price: number): number => Math.max(300, Math.min(1500, Math.round((price * 0.012) / 100) * 100));

// ── agents ──
export interface AgentRule { id: string; name: string; rule: string; floorBps: number; hold: number; maxLots: number }
export const AGENT_RULES: AgentRule[] = [
  { id: 'gap', name: 'Gap hunter', rule: 'The live agent\'s rule: buy only if the margin clears the 10% floor', floorBps: 1000, hold: 40, maxLots: 2 },
  { id: 'sniper', name: 'Sniper', rule: 'Lower floor (3%), flips within a minute and a half', floorBps: 300, hold: 15, maxLots: 2 },
  { id: 'patient', name: 'Patient', rule: 'Needs a 20% margin and holds for nine minutes', floorBps: 2000, hold: 90, maxLots: 1 },
  { id: 'scout', name: 'Scout', rule: 'Takes anything that breaks even, flips in under a minute', floorBps: 0, hold: 8, maxLots: 3 },
];

export interface Lot { round: number; costCents: number }
export interface AgentState {
  rule: AgentRule; cash: number; startCash: number; lots: Lot[]; realized: number; wins: number; losses: number; passes: number; cooldown: number; stance: string; seen: number;
}
export interface LogRow { n: number; t: number; kind: 'BUY' | 'SELL' | 'DECLINE' | 'MISS' | 'FLAG'; agent: string; text: string; cents: number | null }

export interface Engine {
  profile: Profile;
  anchor: number;
  head: number;
  rounds: RoundInfo[];
  log: LogRow[];
  agents: AgentState[];
  advanceTo(n: number): void;
  info(n: number): RoundInfo | null;
  book(n: number): Book | null;
  equity(a: AgentState): number;
}

export function createEngine(p: Profile, now: number = Date.now()): Engine {
  const startRound = roundOf(now);
  const anchor = anchorOf(startRound);
  const rounds: RoundInfo[] = [];
  const log: LogRow[] = [];
  const agents: AgentState[] = AGENT_RULES.map((rule) => ({ rule, cash: p.fairCents * START_CASH_LOTS, startCash: p.fairCents * START_CASH_LOTS, lots: [], realized: 0, wins: 0, losses: 0, passes: 0, cooldown: 0, stance: 'Waiting for the first round', seen: -1 }));
  let lnMid = Math.log(p.fairCents) + gauss(p.seed, anchor, 70) * 0.006;
  let volState = 1;
  let cur = anchor - 1;

  const fairAt = (n: number): number => p.fairCents * (1 + (p.amplitudeBps / 10_000) * Math.sin((2 * Math.PI * n) / p.periodRounds + p.phase));
  const money = (c: number): string => `${(c / 100).toFixed(2)} ${p.currency}`;
  const push = (r: LogRow): void => { log.push(r); if (log.length > 500) log.shift(); };

  function step(n: number): void {
    const z = gauss(p.seed, n, 71);
    volState = 0.94 * volState + 0.06 * Math.abs(z) * 1.25;
    lnMid += p.kappa * (Math.log(fairAt(n)) - lnMid) + ((p.sigmaBps * (0.7 + 0.6 * volState)) / 10_000) * z;
    const mid = Math.exp(lnMid);
    const book = bookAt(p, n, mid);
    const ok = book.offers.filter((o) => !o.flagged);
    const best = ok[0] ?? null;
    const second = ok[1] ?? null;
    const t = n * ROUND_MS;
    const info: RoundInfo = { n, t, mid, ask: best?.landedCents ?? null, askSeller: best?.seller ?? '', askPrice: best?.priceCents ?? 0, askShip: best?.shipCents ?? 0, next: second?.priceCents ?? null, identical: ok.length, considered: book.considered, flagged: book.offers.length - ok.length, gap: book.gap };
    rounds.push(info);

    if (book.gap?.cls === 'bait' && book.offers.some((o) => o.flagged) && book.gap.start === n) {
      const f = book.offers.find((o) => o.flagged)!;
      push({ n, t, kind: 'FLAG', agent: 'Gate', text: `${f.seller} at ${money(f.landedCents)} set aside: far below the others, too good to be true`, cents: f.landedCents });
    }

    for (const a of agents) {
      // exits first
      for (let i = a.lots.length - 1; i >= 0; i--) {
        const lot = a.lots[i];
        if (n - lot.round < a.rule.hold || best === null) continue;
        // A quick flip has to undercut the going price to sell; a patient listing does not.
        const concession = (a.rule.hold < 20 ? 0.02 : a.rule.hold < 50 ? 0.008 : 0.002) * (0.5 + u(p.seed, n * 7 + a.rule.hold, 80));
        const sellAt = Math.round(best.priceCents * (1 - concession));
        const r = arbitrage({ priceCents: lot.costCents, shippingCents: 0, dutyBps: 0, vatBps: 0, paymentFeeBps: 0 }, { sellCents: sellAt, marketplaceFeeBps: FEE_BPS, outboundShippingCents: outbound(sellAt), returnReserveBps: RESERVE_BPS });
        a.cash += r.netCents + lot.costCents;
        a.realized += r.netCents;
        if (r.netCents >= 0) a.wins++; else a.losses++;
        a.lots.splice(i, 1);
        push({ n, t, kind: 'SELL', agent: a.rule.name, text: `Resold for ${money(sellAt)}, net ${r.netCents >= 0 ? '+' : ''}${money(r.netCents)} after fees (${(r.marginBps / 100).toFixed(1)}%)`, cents: r.netCents });
      }
      if (a.cooldown > 0) a.cooldown--;
      if (!best || !second) { a.stance = 'No identical offer in the book'; continue; }
      const gross = ((second.priceCents - best.priceCents) / best.priceCents) * 100;
      const r = arbitrage({ priceCents: best.priceCents, shippingCents: best.shipCents, dutyBps: 0, vatBps: 0, paymentFeeBps: 0 }, { sellCents: second.priceCents, marketplaceFeeBps: FEE_BPS, outboundShippingCents: outbound(second.priceCents), returnReserveBps: RESERVE_BPS }, a.rule.floorBps);
      const need = `${(a.rule.floorBps / 100).toFixed(0)}%`;
      const gapNow = book.gap;
      if (r.verdict === 'profitable' && r.marginBps > IMPLAUSIBLE_BPS) {
        a.stance = `Gap ${gross.toFixed(1)}% looks too good to be true, skipped`;
        if (a.seen !== gapNow?.start) { a.seen = gapNow?.start ?? -1; a.passes++; push({ n, t, kind: 'DECLINE', agent: a.rule.name, text: `Declined ${best.seller} at ${money(best.landedCents)}: margin ${(r.marginBps / 100).toFixed(0)}% is too good to be true`, cents: null }); }
      } else if (r.verdict === 'profitable' && a.lots.length < a.rule.maxLots && a.cooldown === 0 && a.cash >= r.landedCents && u(p.seed, n * 5 + a.rule.maxLots, 81) >= 0.4) {
        a.cash -= r.landedCents;
        a.lots.push({ round: n, costCents: r.landedCents });
        a.cooldown = 6;
        a.stance = `Bought at ${money(best.landedCents)}, net ${(r.marginBps / 100).toFixed(1)}% expected`;
        push({ n, t, kind: 'BUY', agent: a.rule.name, text: `Bought at ${money(best.landedCents)} from ${best.seller}; resale ${money(second.priceCents)} would net ${(r.marginBps / 100).toFixed(1)}%`, cents: r.landedCents });
      } else if (r.verdict === 'profitable' && a.lots.length < a.rule.maxLots && a.cooldown === 0) {
        a.cooldown = 3;
        a.stance = 'Order missed: the listing was gone first';
        push({ n, t, kind: 'MISS', agent: a.rule.name, text: `Order for ${best.seller} at ${money(best.landedCents)} missed: another buyer got there first`, cents: null });
      } else if (gross >= 2) {
        a.stance = `Gap ${gross.toFixed(1)}%, net ${(r.marginBps / 100).toFixed(1)}% after costs, needs ${need}`;
        if (a.seen !== gapNow?.start && gapNow) { a.seen = gapNow.start; a.passes++; push({ n, t, kind: 'DECLINE', agent: a.rule.name, text: `Passed on ${best.seller} at ${money(best.landedCents)}: ${gross.toFixed(1)}% gap, net ${(r.marginBps / 100).toFixed(1)}% after costs, needs ${need}`, cents: null }); }
      } else {
        a.stance = `No gap (${Math.max(gross, 0).toFixed(1)}%). Needs ${need} net, fees alone take ${((FEE_BPS + RESERVE_BPS) / 100).toFixed(0)}%`;
      }
    }
  }

  const engine: Engine = {
    profile: p, anchor, head: anchor - 1, rounds, log, agents,
    advanceTo(n) { while (cur < n) { cur++; step(cur); engine.head = cur; } },
    info(n) { return rounds[n - anchor] ?? null; },
    book(n) { const i = rounds[n - anchor]; return i ? bookAt(p, n, i.mid) : null; },
    equity(a) {
      const last = rounds[rounds.length - 1];
      const mark = last?.ask ? last.askPrice : 0;
      return a.cash + a.lots.reduce((s, l) => s + (mark ? arbitrage({ priceCents: l.costCents, shippingCents: 0, dutyBps: 0, vatBps: 0, paymentFeeBps: 0 }, { sellCents: mark, marketplaceFeeBps: FEE_BPS, outboundShippingCents: outbound(mark), returnReserveBps: RESERVE_BPS }).netCents + l.costCents : l.costCents), 0);
    },
  };
  engine.advanceTo(startRound);
  return engine;
}

// ── helpers for the view ──
export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

/** The last `count` rounds of cheapest-landed prices, thinned to at most `max` points (the last price of each bucket). */
export function seriesOf(e: Engine, count: number, max: number): { t: number; y: number; v: number }[] {
  const all = e.rounds.filter((r) => r.ask !== null).slice(-count);
  const size = Math.max(1, Math.ceil(all.length / max));
  const out: { t: number; y: number; v: number }[] = [];
  // v is how far the price moved, in basis points, added up over the bucket
  const move = (i: number): number => (i > 0 ? Math.round((Math.abs(all[i].ask! - all[i - 1].ask!) / all[i - 1].ask!) * 10_000) : 0);
  for (let i = 0; i < all.length; i += size) {
    const end = Math.min(i + size - 1, all.length - 1);
    let v = 0;
    for (let k = i; k <= end; k++) v += move(k);
    out.push({ t: all[end].t, y: all[end].ask!, v });
  }
  return out;
}

/** How a typical five minutes moves, from the profile alone. */
export const fiveMinuteMovePct = (p: Profile): number => (p.sigmaBps * Math.sqrt(50)) / 100;
/** Minutes between price gaps, on average. */
export const minutesPerGap = (p: Profile): number => Math.round((1 / (p.gapPerThousand / 1000)) * (ROUND_MS / 60000) * 10) / 10;
