import { arbitrage, landed, type BuyCost } from './economics.ts';
import { IDENTITY_VERSION, buildPrompt, passesGate, type IdentityResult, type Listing } from './identity.ts';
import { MARKETS } from './serpapi.ts';
import { hashKey, type Store } from './store.ts';
import type { Analysis, AnalyzeEvent, ArbitrageView, Assumptions, Flagged, Gated, Offer, Priced, Proposal, SellView } from './types.ts';
import { briefingFor, type BriefingFacts } from './briefing.ts';
import type { VisionEngine, VisionResult } from './vision.ts';
import { randomBytes } from 'node:crypto';
import { DEFAULT_LIMITS, logEvent, recordHistory, type Limits } from './domain.ts';

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  unknownShippingCents: 1000,
  buyTaxBps: 0,
  marketplaceFeeBps: 1300,
  returnReserveBps: 200,
  outboundShippingCents: 1500,
  minMarginBps: 1000,
};

const MAX_OFFERS = 30;
const IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Engine {
  compare(a: Listing, b: Listing): Promise<IdentityResult>;
}

export interface AgentDeps {
  search(query: string, marketCode: string, opts: { fresh?: boolean }): Promise<{ offers: Offer[]; fromCache: boolean }>;
  engine: Engine;
  // Typical retail price in cents for the queried product, or null when unknown. Optional.
  retail?: (query: string, currency: string) => Promise<number | null>;
  // Photo check: Gemini looks at the listing's picture. Optional; it can only take a text match away.
  vision?: VisionEngine;
  // Plain-language note from the model, grounded in the computed numbers. Optional.
  briefing?: (facts: BriefingFacts) => Promise<string | null>;
  // Owner-set limits and kill switch. Defaults apply when absent.
  limits?: () => Promise<Limits>;
  store: Store;
  model: string;
  now?: () => Date;
  concurrency?: number;
}

export interface AnalyzeRequest {
  query: string;
  market: string;
  assumptions?: Partial<Assumptions>;
  fresh?: boolean;
  // A scheduled scan: no human is waiting, so no decision token is issued.
  system?: boolean;
}

const isEngineError = (r: IdentityResult): boolean => r.mismatches.some((m) => m.startsWith('engine error'));

// Same pair, same prompt, same model -> same answer, so verdicts are cached. Engine errors are never cached.
async function compareCached(deps: AgentDeps, a: Listing, b: Listing): Promise<IdentityResult> {
  const id = hashKey(`${deps.model}|v${IDENTITY_VERSION}|${buildPrompt(a, b)}`);
  const hit = await deps.store.get<{ result: IdentityResult; expiresAt: number }>('identity', id);
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (hit && hit.expiresAt > now) return hit.result;
  const result = await deps.engine.compare(a, b);
  if (!isEngineError(result)) await deps.store.set('identity', id, { result, expiresAt: now + IDENTITY_TTL_MS });
  return result;
}

// A photo opinion for the same query and picture does not change, so it is cached like the text verdicts. No opinion is never cached.
async function visionCached(deps: AgentDeps, query: string, offer: Offer): Promise<VisionResult | null> {
  if (!deps.vision) return null;
  const id = hashKey(`${deps.model}|vision|${query.toLowerCase()}|${offer.thumbnail}|${offer.title}`);
  const hit = await deps.store.get<{ result: VisionResult; expiresAt: number }>('vision', id);
  const now = (deps.now ?? (() => new Date()))().getTime();
  if (hit && hit.expiresAt > now) return hit.result;
  const result = await deps.vision.check(query, offer);
  if (result) await deps.store.set('vision', id, { result, expiresAt: now + IDENTITY_TTL_MS });
  return result;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  }));
  return out;
}

function dedupe(offers: Offer[]): Offer[] {
  const seen = new Set<string>();
  return offers.filter((o) => {
    const k = `${o.seller}|${o.title}|${o.priceCents}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const asListing = (o: Offer): Listing => ({ id: o.id, title: o.title, condition: o.secondHand ? 'used' : 'new_sealed' });

function price(o: Offer, a: Assumptions): { cost: BuyCost; assumed: boolean } {
  const assumed = o.shippingCents === null;
  return {
    assumed,
    cost: { priceCents: o.priceCents, shippingCents: o.shippingCents ?? a.unknownShippingCents, dutyBps: 0, vatBps: a.buyTaxBps, paymentFeeBps: 0 },
  };
}

export const OUTLIER_FLOOR = 0.4;
export const RETAIL_FLOOR = 0.5;
export const IMPLAUSIBLE_MARGIN_BPS = 5000;

// Identity says the product matches; it cannot say the price is real. A price far below the median of the other
// identical offers, or below half the recalled retail price, is far more likely a data error or bait than a bargain,
// so it is set aside and not traded on.
export function splitOutliers(sorted: Priced[], retailCents: number | null = null): { kept: Priced[]; flagged: Flagged[] } {
  let median: number | null = null;
  if (sorted.length >= 3) {
    const mid = Math.floor(sorted.length / 2);
    median = sorted.length % 2 ? sorted[mid].landedCents : Math.round((sorted[mid - 1].landedCents + sorted[mid].landedCents) / 2);
  }
  const kept: Priced[] = [];
  const flagged: Flagged[] = [];
  for (const p of sorted) {
    if (retailCents !== null && p.offer.priceCents < retailCents * RETAIL_FLOOR) flagged.push({ ...p, reason: 'retail', referenceCents: retailCents });
    else if (median !== null && p.landedCents < median * OUTLIER_FLOOR) flagged.push({ ...p, reason: 'median', referenceCents: median });
    else kept.push(p);
  }
  return { kept, flagged };
}

const money = (cents: number, currency: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

export async function analyze(req: AnalyzeRequest, deps: AgentDeps, emit: (e: AnalyzeEvent) => void = () => {}): Promise<Analysis> {
  const market = MARKETS[req.market];
  if (!market) throw new Error(`unknown market ${req.market}`);
  const limits = await (deps.limits?.() ?? Promise.resolve(DEFAULT_LIMITS)).catch(() => DEFAULT_LIMITS);
  const scale = market.scale ?? 1;
  const assumptions: Assumptions = {
    ...DEFAULT_ASSUMPTIONS, minMarginBps: limits.minMarginBps,
    unknownShippingCents: DEFAULT_ASSUMPTIONS.unknownShippingCents * scale, outboundShippingCents: DEFAULT_ASSUMPTIONS.outboundShippingCents * scale,
    ...req.assumptions,
  };
  const now = (deps.now ?? (() => new Date()))();
  const query = req.query.trim();

  const { offers: raw, fromCache } = await deps.search(query, market.code, { fresh: req.fresh });
  // Listings the source itself labels pre-owned or refurbished can never be the factory-new product, so they are not sent to the gate
  // and the slots go to listings that can be.
  const preOwned = raw.filter((o) => o.secondHand).length;
  const offers = dedupe(raw.filter((o) => !o.secondHand)).slice(0, MAX_OFFERS);
  emit({ type: 'search', listings: offers.length, fromCache });

  // The Identity Engine is the only gate. The anchor is the user's own query, treated as a sealed new item.
  const anchor: Listing = { id: 'query', title: query, condition: 'new_sealed' };
  let done = 0;
  const gated: Gated[] = await mapLimit(offers, deps.concurrency ?? 5, async (offer) => {
    const r = await compareCached(deps, anchor, asListing(offer));
    const g: Gated = { offer, quoted: r.evidence ? { brand: r.evidence.brand, brandQuote: r.evidence.brandQuoteB, idQuote: r.evidence.idB } : undefined, verdict: passesGate(r) ? 'identical' : r.verdict === 'identical' ? 'uncertain' : r.verdict, confidence: r.confidence, reasons: r.reasons, mismatches: r.mismatches };
    emit({ type: 'gate', done: ++done, total: offers.length, verdict: g.verdict, seller: offer.seller, title: offer.title.slice(0, 90), thumbnail: offer.thumbnail });
    return g;
  });

  // Photo check on the listings the text already accepted. A photo that shows something else takes the match away.
  let photosChecked = 0, photosRefused = 0;
  const withPhoto = gated.filter((g) => g.verdict === 'identical' && g.offer.thumbnail);
  if (deps.vision && withPhoto.length) {
    let seen = 0;
    await mapLimit(withPhoto, 4, async (g) => {
      const v = await visionCached(deps, query, g.offer);
      if (v) {
        photosChecked++;
        g.visual = { verdict: v.verdict, seen: v.seen };
        if (v.verdict === 'different') { photosRefused++; g.verdict = 'different'; g.mismatches = [...g.mismatches, `photo: ${v.seen}`]; }
      }
      emit({ type: 'vision', done: ++seen, total: withPhoto.length, verdict: v?.verdict ?? 'unclear', seller: g.offer.seller, seen: v?.seen ?? '' });
    });
  }

  const passed: Priced[] = gated
    .filter((g) => g.verdict === 'identical')
    .map((g) => {
      const { cost, assumed } = price(g.offer, assumptions);
      const l = landed(cost);
      return { ...g, shippingAssumed: assumed, landedCents: l.landedCents, steps: l.steps };
    })
    .sort((a, b) => a.landedCents - b.landedCents);
  const rejected = gated.filter((g) => g.verdict !== 'identical');

  // Identity says the product matches; it cannot say the price is real. A price far below the median of the
  // other identical offers is far more likely a data error or bait than a bargain, so it is set aside, not traded on.
  const retailCents = passed.length && deps.retail ? await deps.retail(query, market.currency).catch(() => null) : null;
  const { kept: identical, flagged } = splitOutliers(passed, retailCents);
  emit({ type: 'sanity', flagged: flagged.length, retailCents });

  const buy = identical[0] ?? null;

  // A buyer can choose any identical offer, so the price to match is the cheapest one, retailer or marketplace.
  const byPrice = [...identical].sort((x, y) => x.offer.priceCents - y.offer.priceCents);
  const sellFrom = (ref: Priced): SellView => {
    const list = ref.offer.priceCents;
    const fee = Math.round((list * assumptions.marketplaceFeeBps) / 10_000);
    const reserve = Math.round((list * assumptions.returnReserveBps) / 10_000);
    return { referenceOffer: ref.offer, listAtCents: list, feeCents: fee, reserveCents: reserve, outboundShippingCents: assumptions.outboundShippingCents, netBeforeCostCents: list - fee - reserve - assumptions.outboundShippingCents };
  };
  const sell: SellView | null = byPrice[0] ? sellFrom(byPrice[0]) : null;

  // Arbitrage: buy the cheapest landed identical offer, resell (on a marketplace) at the next cheapest identical price.
  let arb: ArbitrageView | null = null;
  const same = (x: Offer, y: Offer): boolean => x.id === y.id && x.seller === y.seller && x.priceCents === y.priceCents;
  const ref = buy ? byPrice.find((p) => !same(p.offer, buy.offer)) : undefined;
  if (buy && ref) {
    const a = arbitrage(price(buy.offer, assumptions).cost, { sellCents: ref.offer.priceCents, marketplaceFeeBps: assumptions.marketplaceFeeBps, outboundShippingCents: assumptions.outboundShippingCents, returnReserveBps: assumptions.returnReserveBps }, assumptions.minMarginBps);
    arb = { buy, sellReference: ref.offer, netCents: a.netCents, marginBps: a.marginBps, verdict: a.verdict, implausible: a.verdict === 'profitable' && a.marginBps > IMPLAUSIBLE_MARGIN_BPS, steps: a.steps };
  }

  emit({ type: 'economics' });
  const cur = market.currency;
  const notes = [
    'Offers are listed as new (not second-hand) on Google Shopping; the Identity Engine still checks the title, and sellers can mis-describe.',
    'Prices are asking prices, not sold prices.',
    assumptions.buyTaxBps === 0 ? 'Sales tax is not included in landed cost.' : `Tax of ${assumptions.buyTaxBps / 100}% is included in landed cost.`,
  ];
  const assumedCount = identical.filter((p) => p.shippingAssumed).length;
  if (assumedCount) notes.push(`${assumedCount} identical offer(s) did not state shipping; ${money(assumptions.unknownShippingCents, cur)} was assumed.`);

  if (flagged.length) notes.push(`${flagged.length} offer(s) matched the product but had a price that cannot be believed (under ${RETAIL_FLOOR * 100}% of the recalled retail price or under ${OUTLIER_FLOOR * 100}% of the median identical price), so they were treated as data errors and not traded on.`);
  if (retailCents !== null) notes.push(`Gemini recalls a typical retail price of ${money(retailCents, cur)} for this product. This is recalled knowledge, not a live quote.`);
  notes.push('Resale is assumed at the next cheapest identical price, because a buyer can pick any identical offer.');
  if (preOwned) notes.push(`${preOwned} listing${preOwned === 1 ? ' was' : 's were'} left out because the source labels ${preOwned === 1 ? 'it' : 'them'} pre-owned or refurbished.`);
  if (photosChecked) notes.push(`Gemini also looked at ${photosChecked} listing photo${photosChecked === 1 ? '' : 's'}${photosRefused ? `; ${photosRefused} showed something other than the product and ${photosRefused === 1 ? 'was' : 'were'} dropped` : ' and none contradicted the text'}.`);

  const counts = { considered: gated.length, identical: passed.length, different: gated.filter((g) => g.verdict === 'different').length, uncertain: gated.filter((g) => g.verdict === 'uncertain').length };

  const engineErrors = gated.filter((g) => g.mismatches.some((m) => m.startsWith('engine error'))).length;
  const degraded = gated.length > 0 && engineErrors / gated.length >= 0.3;
  if (engineErrors && !degraded) notes.push(`${engineErrors} listing(s) could not be judged because the Identity Engine was unavailable; they were treated as not provable.`);

  let headline: string;
  if (degraded) {
    headline = `The Identity Engine was unavailable for ${engineErrors} of ${gated.length} listings, so this is not a verdict. Nothing was filed. Try again in a minute.`;
  } else if (!buy) {
    headline = gated.length === 0
      ? `No listings found for "${query}".`
      : `No identical sealed product found. ${counts.considered} listings checked, none cleared the Identity Engine, so there is nothing to buy or compare.`;
  } else if (!arb) {
    headline = `Cheapest identical sealed item: ${money(buy.landedCents, cur)} landed at ${buy.offer.seller}. No second identical marketplace ask to compare, so no arbitrage verdict.`;
  } else if (arb.verdict === 'profitable' && arb.marginBps > IMPLAUSIBLE_MARGIN_BPS) {
    headline = `Too good to be true: a ${(arb.marginBps / 100).toFixed(0)}% margin on ${buy.offer.seller} is far above what real markets leave. Treat it as a probable data error or bait and verify the listing before acting. SKUdesk does not call this arbitrage.`;
  } else if (arb.verdict === 'profitable') {
    headline = `Arbitrage clears: buy at ${buy.offer.seller} for ${money(buy.landedCents, cur)} landed, resell at ${money(arb.sellReference.priceCents, cur)}, net ${money(arb.netCents, cur)} (${(arb.marginBps / 100).toFixed(1)}%) after all costs.`;
  } else if (arb.verdict === 'thin') {
    headline = `Thin: net ${money(arb.netCents, cur)} (${(arb.marginBps / 100).toFixed(1)}%) is below the ${assumptions.minMarginBps / 100}% floor. Not worth the risk.`;
  } else {
    headline = `No arbitrage: after fees and shipping the resale at ${money(arb.sellReference.priceCents, cur)} loses ${money(-arb.netCents, cur)} against a ${money(buy.landedCents, cur)} landed cost. Cheapest identical item is at ${buy.offer.seller}.`;
  }

  const analysis: Analysis = {
    id: `${now.getTime().toString(36)}-${hashKey(`${query}|${market.code}`).slice(0, 6)}`,
    query,
    market: market.code,
    currency: cur,
    createdAt: now.toISOString(),
    model: 'Gemini',
    searched: raw.length,
    gate: counts,
    identical: identical.slice(0, 10),
    flagged: flagged.slice(0, 6),
    rejected: rejected.slice(0, 12),
    buy,
    sell,
    arbitrage: arb,
    headline,
    retailCents,
    briefing: null,
    assumptions,
    notes,
    proposalId: null,
    ...(degraded ? { degraded: true } : {}),
    fromCache,
  };

  if (deps.briefing && buy) {
    emit({ type: 'briefing' });
    analysis.briefing = await deps.briefing({
      query, currency: cur, listings: counts.considered, identical: counts.identical, flagged: flagged.length, retailCents,
      buy: { seller: buy.offer.seller, landedCents: buy.landedCents },
      arbitrage: arb ? { verdict: arb.verdict, netCents: arb.netCents, marginBps: arb.marginBps, sellCents: arb.sellReference.priceCents } : null,
    }).catch(() => null);
  }

  // Every spend needs a human. The agent only ever files a pending proposal, and not at all while the owner has paused it.
  let token: string | undefined;
  if (degraded) {
    analysis.notes.push('Upstream errors: no proposal was filed and this check is not counted in the totals.');
  } else if (buy && limits.paused) {
    analysis.notes.push('The agent is paused by its owner, so no proposal was filed.');
  } else if (buy) {
    token = req.system ? undefined : randomBytes(24).toString('hex');
    const overLimit = buy.landedCents > limits.maxSpendCents;
    const proposal: Proposal = {
      id: hashKey(`proposal|${analysis.id}`).slice(0, 16),
      analysisId: analysis.id,
      query,
      createdAt: analysis.createdAt,
      action: 'buy',
      seller: buy.offer.seller,
      url: buy.offer.url,
      title: buy.offer.title,
      landedCents: buy.landedCents,
      currency: cur,
      status: 'pending',
      origin: req.system ? 'scan' : 'user',
      ...(token ? { tokenHash: hashKey(`token|${token}`) } : {}),
      ...(overLimit ? { blockedReason: `Landed cost ${money(buy.landedCents, cur)} is above the owner's per-buy limit of ${money(limits.maxSpendCents, cur)}.` } : {}),
    };
    await deps.store.set('proposals', proposal.id, proposal);
    analysis.proposalId = proposal.id;
    if (overLimit) analysis.notes.push(proposal.blockedReason!);
  }
  await deps.store.set('analyses', analysis.id, analysis);
  // The activity log and price history are best effort: a failure there must never break an analysis.
  await Promise.all([
    logEvent(deps.store, 'analysis', `Checked ${query}`, analysis.headline).catch(() => {}),
    analysis.proposalId ? logEvent(deps.store, 'proposal', `Proposal filed for ${query}`, `${buy!.offer.seller} at ${money(buy!.landedCents, cur)} landed, awaiting a decision`).catch(() => {}) : Promise.resolve(),
    degraded ? Promise.resolve() : recordHistory(deps.store, analysis).catch(() => {}),
  ]);
  const out = token ? { ...analysis, decisionToken: token } : analysis;
  emit({ type: 'done', analysis: out });
  return out;
}
