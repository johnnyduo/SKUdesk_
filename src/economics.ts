// All money is integer minor units (cents). Rates are basis points (1 bp = 0.01%).
// Every function is pure so each number in a verdict can be reproduced by hand.

export interface BuyCost {
  priceCents: number;
  shippingCents: number;
  dutyBps: number;
  vatBps: number;
  paymentFeeBps: number;
}

export interface SellSide {
  sellCents: number;
  marketplaceFeeBps: number;
  outboundShippingCents: number;
  returnReserveBps: number;
}

export interface Step {
  label: string;
  cents: number;
}

export interface Landed {
  landedCents: number;
  steps: Step[];
}

export type Verdict = 'profitable' | 'thin' | 'loss';

export interface Arbitrage extends Landed {
  netCents: number;
  marginBps: number;
  verdict: Verdict;
}

const rate = (cents: number, bps: number): number => Math.round((cents * bps) / 10_000);

export function landed(c: BuyCost): Landed {
  const goods = c.priceCents + c.shippingCents;
  const duty = rate(goods, c.dutyBps);
  const vat = rate(goods + duty, c.vatBps);
  const payment = rate(goods + duty + vat, c.paymentFeeBps);
  return {
    landedCents: goods + duty + vat + payment,
    steps: [
      { label: 'price', cents: c.priceCents },
      { label: 'shipping', cents: c.shippingCents },
      { label: 'duty', cents: duty },
      { label: 'vat', cents: vat },
      { label: 'payment fee', cents: payment },
    ],
  };
}

// A trade clears only if it still earns minMarginBps after every cost; below that it is "thin".
export function arbitrage(buy: BuyCost, sell: SellSide, minMarginBps = 1000): Arbitrage {
  const l = landed(buy);
  const fee = rate(sell.sellCents, sell.marketplaceFeeBps);
  const reserve = rate(sell.sellCents, sell.returnReserveBps);
  const netCents = sell.sellCents - fee - reserve - sell.outboundShippingCents - l.landedCents;
  const marginBps = l.landedCents > 0 ? Math.round((netCents * 10_000) / l.landedCents) : 0;
  const verdict: Verdict = netCents <= 0 ? 'loss' : marginBps >= minMarginBps ? 'profitable' : 'thin';
  return {
    landedCents: l.landedCents,
    steps: [
      ...l.steps,
      { label: 'marketplace fee', cents: fee },
      { label: 'return reserve', cents: reserve },
      { label: 'outbound shipping', cents: sell.outboundShippingCents },
    ],
    netCents,
    marginBps,
    verdict,
  };
}
