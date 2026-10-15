import type { Step, Verdict } from './economics.ts';
import type { IdentityVerdict } from './identity.ts';

export type Channel = 'retailer' | 'marketplace';

export interface Offer {
  id: string;
  title: string;
  seller: string;
  channel: Channel;
  priceCents: number;
  currency: string;
  // null when the listing does not state shipping; the analysis then applies an assumption and says so.
  shippingCents: number | null;
  secondHand: boolean;
  url: string;
  thumbnail?: string;
  origin: 'serpapi' | 'ebay';
}

export interface Market {
  code: string;
  label: string;
  gl: string;
  hl: string;
  currency: string;
}

export interface Assumptions {
  unknownShippingCents: number;
  buyTaxBps: number;
  marketplaceFeeBps: number;
  returnReserveBps: number;
  outboundShippingCents: number;
  minMarginBps: number;
}

export interface Gated {
  offer: Offer;
  verdict: IdentityVerdict;
  confidence: number;
  reasons: string[];
  mismatches: string[];
}

export interface Priced extends Gated {
  shippingAssumed: boolean;
  landedCents: number;
  steps: Step[];
}

export interface Flagged extends Priced {
  reason: 'retail' | 'median';
  referenceCents: number;
}

export interface SellView {
  referenceOffer: Offer;
  listAtCents: number;
  feeCents: number;
  reserveCents: number;
  outboundShippingCents: number;
  netBeforeCostCents: number;
}

export interface ArbitrageView {
  buy: Priced;
  sellReference: Offer;
  netCents: number;
  marginBps: number;
  verdict: Verdict;
  implausible: boolean;
  steps: Step[];
}

export interface Analysis {
  id: string;
  query: string;
  market: string;
  currency: string;
  createdAt: string;
  model: string;
  searched: number;
  gate: { considered: number; identical: number; different: number; uncertain: number };
  identical: Priced[];
  flagged: Flagged[];
  rejected: Gated[];
  buy: Priced | null;
  sell: SellView | null;
  arbitrage: ArbitrageView | null;
  headline: string;
  assumptions: Assumptions;
  notes: string[];
  proposalId: string | null;
  fromCache: boolean;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface Proposal {
  id: string;
  analysisId: string;
  query: string;
  createdAt: string;
  action: 'buy';
  seller: string;
  url: string;
  title: string;
  landedCents: number;
  currency: string;
  status: ProposalStatus;
  decidedAt?: string;
}
