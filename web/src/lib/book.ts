import type { Analysis } from './book-types.ts';

// The agents' side of the offer book, computed from a stored check. Each buyer policy is the live agent's cost model with a different
// margin floor. Its bid is the highest landed price it could pay and still clear that floor when the item is resold at the next
// cheapest identical price. Nothing here is invented: the offers, the resale reference and the costs all come from the check.

export interface Policy { id: string; name: string; rule: string; mult: number }
export const POLICIES: Policy[] = [
  { id: 'patient', name: 'Patient', rule: 'Wants twice the margin floor', mult: 2 },
  { id: 'live', name: 'Live agent', rule: 'The owner\'s margin floor', mult: 1 },
  { id: 'sniper', name: 'Sniper', rule: 'Half the margin floor', mult: 0.5 },
  { id: 'scout', name: 'Scout', rule: 'Break-even after costs', mult: 0 },
];

const rate = (cents: number, bps: number): number => Math.round((cents * bps) / 10_000);

/** The most a buyer can pay, landed, and still earn floorBps after every cost. Null when the costs alone eat the resale price. */
export function ceilingCents(sellCents: number, a: { marketplaceFeeBps: number; returnReserveBps: number; outboundShippingCents: number }, floorBps: number): number | null {
  const room = sellCents - rate(sellCents, a.marketplaceFeeBps) - rate(sellCents, a.returnReserveBps) - a.outboundShippingCents;
  if (room <= 0) return null;
  return Math.floor((room * 10_000) / (10_000 + floorBps));
}

export interface Bid { policy: Policy; floorBps: number; ceilingCents: number | null; vsAvgPct: number | null; crosses: boolean; gapPct: number | null }

export const average = (cents: number[]): number | null => (cents.length ? Math.round(cents.reduce((s, c) => s + c, 0) / cents.length) : null);
export const vsAvg = (cents: number, avg: number | null): number | null => (avg ? ((cents - avg) / avg) * 100 : null);

/** One bid per policy, highest first. Empty when there is no resale reference (fewer than two identical offers). */
export function bidsFor(a: Analysis, ownerFloorBps: number): Bid[] {
  const sellCents = a.arbitrage?.sellReference.priceCents;
  if (!sellCents) return [];
  const avg = average(a.identical.map((p) => p.landedCents));
  const best = a.buy?.landedCents ?? null;
  return POLICIES.map((policy): Bid => {
    const floorBps = Math.round(ownerFloorBps * policy.mult);
    const c = ceilingCents(sellCents, a.assumptions, floorBps);
    return { policy, floorBps, ceilingCents: c, vsAvgPct: c === null ? null : vsAvg(c, avg), crosses: c !== null && best !== null && best <= c, gapPct: c !== null && best !== null ? ((best - c) / c) * 100 : null };
  }).sort((x, y) => (y.ceilingCents ?? -1) - (x.ceilingCents ?? -1));
}

/** The bid that would take the best ask: the highest one that reaches it. */
export const winner = (bids: Bid[]): Bid | null => bids.find((b) => b.crosses) ?? null;

export const providerOf = (origin: string): string => (origin === 'ebay' ? 'eBay' : 'Google Shopping');
