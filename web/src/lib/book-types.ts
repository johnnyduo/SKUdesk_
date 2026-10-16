// The parts of a stored check the offer book reads. The full shape lives in src/types.ts on the server.
export interface Analysis {
  identical: { landedCents: number }[];
  buy: { landedCents: number } | null;
  // the next cheapest identical offer after the best ask: the price a resale is matched to
  arbitrage: { sellReference: { priceCents: number } } | null;
  assumptions: { marketplaceFeeBps: number; returnReserveBps: number; outboundShippingCents: number };
}
