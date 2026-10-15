import { api, ApiError, h, int, money, ownerKey, pct, postJson, rememberToken, safeLink, thumbSrc, tokenFor, verdictPill } from './client.ts';

type A = any;

const thumbOf = (o: any): HTMLElement => h('span', { class: 'thumb' }, thumbSrc(o.thumbnail) ? h('img', { src: thumbSrc(o.thumbnail)!, alt: '', loading: 'lazy' }) : null);

export function offerRow(p: any, cur: string, mode: 'identical' | 'flagged' | 'rejected'): HTMLElement {
  const o = p.offer;
  const sub = [o.seller, o.channel];
  if (mode !== 'rejected') sub.push(p.shippingAssumed ? 'shipping assumed' : (o.shippingCents === 0 ? 'free shipping' : `shipping ${money(o.shippingCents, cur)}`));
  const pills: HTMLElement[] = [];
  if (mode === 'identical') {
    pills.push(h('span', { class: 'pill good' }, `identical ${Math.round(p.confidence * 100)}%`));
    if (p.quoted?.brandQuote) pills.push(h('span', { class: 'pill q' }, `brand “${p.quoted.brandQuote}”`));
    if (p.quoted?.idQuote) pills.push(h('span', { class: 'pill q' }, `number “${p.quoted.idQuote}”`));
  } else if (mode === 'flagged') {
    pills.push(h('span', { class: 'pill warn' }, 'price looks wrong'));
  } else {
    pills.push(h('span', { class: `pill ${p.verdict === 'different' ? 'bad' : 'warn'}` }, p.verdict));
  }
  const why = mode === 'flagged'
    ? (p.reason === 'retail' ? `under half of the ${money(p.referenceCents, cur)} retail price Gemini recalls` : `under 40% of the ${money(p.referenceCents, cur)} median identical price`) + ', treated as a data error'
    : mode === 'identical' ? p.reasons?.[0] : (p.mismatches?.[0] || p.reasons?.[0]);
  return h('div', { class: 'offer' }, thumbOf(o),
    h('div', { class: 't' }, o.url ? safeLink(o.url, o.title) : h('span', { class: 'title' }, o.title), h('div', { class: 's' }, sub.join(' · '), why ? ` — ${why}` : ''), h('div', { class: 'pills' }, pills)),
    h('div', { class: 'p' }, money(mode === 'rejected' ? o.priceCents : p.landedCents, cur)));
}

function stepsTable(steps: any[], cur: string, total?: { label: string; cents: number }): HTMLElement {
  return h('table', { class: 'kv' }, h('tbody', {},
    steps.filter((s) => s.cents !== 0 || s.label === 'price').map((s) => h('tr', { class: /fee|reserve|outbound/.test(s.label) ? 'neg' : '' }, h('td', {}, s.label), h('td', {}, money(s.cents, cur)))),
    total ? h('tr', { class: 'total' }, h('td', {}, total.label), h('td', {}, money(total.cents, cur))) : null));
}

export function summaryCards(a: A): HTMLElement[] {
  const cur = a.currency;
  const buy = a.buy
    ? h('div', { class: 'card' }, h('h3', {}, 'Buy'), h('div', { class: 'big' }, money(a.buy.landedCents, cur)), h('p', { class: 'muted sm' }, `landed at ${a.buy.offer.seller}`), stepsTable(a.buy.steps, cur, { label: 'landed cost', cents: a.buy.landedCents }))
    : h('div', { class: 'card' }, h('h3', {}, 'Buy'), h('p', { class: 'empty' }, 'No identical sealed item cleared the gate, so there is nothing safe to buy.'));
  const sell = a.sell
    ? h('div', { class: 'card' }, h('h3', {}, 'Sell'), h('div', { class: 'big' }, money(a.sell.listAtCents, cur)), h('p', { class: 'muted sm' }, 'cheapest identical price you must match'),
      h('table', { class: 'kv' }, h('tbody', {},
        h('tr', { class: 'neg' }, h('td', {}, 'marketplace fee'), h('td', {}, `-${money(a.sell.feeCents, cur)}`)),
        h('tr', { class: 'neg' }, h('td', {}, 'return reserve'), h('td', {}, `-${money(a.sell.reserveCents, cur)}`)),
        h('tr', { class: 'neg' }, h('td', {}, 'outbound shipping'), h('td', {}, `-${money(a.sell.outboundShippingCents, cur)}`)),
        h('tr', { class: 'total' }, h('td', {}, 'you keep, before your purchase cost'), h('td', {}, money(a.sell.netBeforeCostCents, cur))))))
    : h('div', { class: 'card' }, h('h3', {}, 'Sell'), h('p', { class: 'empty' }, 'No identical listing to price against.'));
  let arb: HTMLElement;
  if (a.arbitrage) {
    const r = a.arbitrage;
    const pill = r.implausible ? h('span', { class: 'pill warn' }, 'unverified') : h('span', { class: `pill ${r.verdict === 'profitable' ? 'good' : r.verdict === 'thin' ? 'warn' : 'bad'}` }, r.verdict);
    arb = h('div', { class: 'card' }, h('h3', {}, 'Arbitrage'), h('div', { class: `big ${r.netCents < 0 ? 'neg' : 'pos'}` }, money(r.netCents, cur)),
      h('p', { class: 'muted sm' }, 'net after all costs ', pill, ` ${pct(r.marginBps)}`), stepsTable(r.steps, cur));
  } else {
    arb = h('div', { class: 'card' }, h('h3', {}, 'Arbitrage'), h('p', { class: 'empty' }, a.buy ? 'No second identical price to resell against.' : 'None. The gate found no identical product.'));
  }
  return [buy, sell, arb];
}

function bar(frac: number): HTMLElement {
  const b = h('div', { class: 'bar' });
  b.style.width = `${Math.max(2, Math.min(100, frac * 100))}%`;
  return h('div', { class: 'bar-track' }, b);
}

export function priceLadder(a: A): HTMLElement | null {
  const cur = a.currency;
  const rows = [...a.identical.map((p: any) => ({ p, kind: '' })), ...(a.flagged ?? []).map((p: any) => ({ p, kind: 'flag' }))].sort((x, y) => x.p.landedCents - y.p.landedCents);
  if (!rows.length) return null;
  const max = Math.max(a.retailCents ?? 0, ...rows.map((r) => r.p.landedCents), 1);
  const out: HTMLElement[] = [];
  if (a.retailCents) out.push(h('div', { class: 'ladder-row ref' }, h('span', { class: 'lbl' }, 'Retail (recalled)'), bar(a.retailCents / max), h('span', { class: 'val' }, money(a.retailCents, cur))));
  for (const { p, kind } of rows) {
    const best = Boolean(a.buy) && p.offer.id === a.buy.offer.id && p.offer.seller === a.buy.offer.seller && p.offer.priceCents === a.buy.offer.priceCents;
    out.push(h('div', { class: `ladder-row ${kind} ${best ? 'best' : ''}` }, h('span', { class: 'lbl', title: p.offer.title }, p.offer.seller), bar(p.landedCents / max), h('span', { class: 'val' }, money(p.landedCents, cur))));
  }
  return h('div', { class: 'ladder' }, out);
}

export function verdictTone(a: A): 'good' | 'warn' | 'none' {
  if (!a.buy || !a.arbitrage) return 'none';
  if (a.arbitrage.implausible) return 'warn';
  return a.arbitrage.verdict === 'profitable' ? 'good' : a.arbitrage.verdict === 'thin' ? 'warn' : 'none';
}

export function verdictBanner(a: A): HTMLElement {
  const tone = verdictTone(a);
  return h('div', { class: `verdict ${tone}` },
    h('span', { class: 'v-tag' }, tone === 'good' ? 'Arbitrage clears' : tone === 'warn' ? 'Handle with care' : a.buy ? 'Honest answer' : 'Nothing to trade'),
    h('p', { class: 'v-text' }, a.headline),
    h('p', { class: 'v-sub' }, `${a.query} · ${a.market.toUpperCase()} · ${a.searched} listings returned${a.fromCache ? ' · cached search, no new quota used' : ''}`));
}

export function approvalPanel(proposalId: string, onChange?: () => void): HTMLElement {
  const box = h('div', { class: 'approval' }, h('p', { class: 'muted sm' }, 'Loading…'));
  const draw = (q: any): void => {
    const owner = Boolean(ownerKey());
    const holds = Boolean(tokenFor(q.id)) || owner;
    const wrap = h('div', { class: 'approval' }, h('div', {}, h('strong', {}, q.title), h('div', { class: 'muted sm' }, `${q.seller} · ${money(q.landedCents, q.currency)} landed`)));
    if (q.blockedReason) wrap.append(h('p', { class: 'pill bad block' }, q.blockedReason));
    if (q.status === 'pending') {
      if (!holds) wrap.append(h('p', { class: 'muted sm' }, 'Waiting for a decision. Only the person who ran this check, or the owner, can approve it.'));
      else {
        const act = async (decision: string): Promise<void> => {
          wrap.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = true; });
          try { draw(await postJson(`/api/proposals/${q.id}/decision`, { decision, token: tokenFor(q.id) }, { owner })); onChange?.(); }
          catch (e) { const err = e as ApiError; draw(err.body?.proposal ?? q); wrap.append(h('p', { class: 'alert' }, err.message)); }
        };
        wrap.append(h('p', { class: 'muted sm' }, 'SKUdesk will not spend anything. Approving unlocks the seller link; you pay on the seller’s site.'),
          h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', disabled: Boolean(q.blockedReason), on: { click: () => act('approved') } }, 'Approve'), h('button', { class: 'btn ghost', type: 'button', on: { click: () => act('rejected') } }, 'Reject')));
      }
    } else if (q.status === 'approved') {
      wrap.append(h('div', { class: 'row' }, h('span', { class: 'pill good' }, 'approved'), q.url ? safeLink(q.url, 'Open the seller page') : 'No link available'));
    } else {
      wrap.append(h('div', { class: 'row' }, h('span', { class: 'pill' }, 'rejected'), h('span', { class: 'muted' }, 'Nothing was bought.')));
    }
    box.replaceChildren(wrap);
  };
  api<any[]>('/api/proposals').then((list) => { const p = list.find((x) => x.id === proposalId); if (p) draw(p); else box.replaceChildren(h('p', { class: 'muted sm' }, 'Proposal not found.')); })
    .catch(() => box.replaceChildren(h('p', { class: 'muted sm' }, 'Could not load the proposal.')));
  return box;
}

// The whole result of one check as a single block of sections.
export function renderAnalysis(a: A, opts: { onDecision?: () => void } = {}): HTMLElement {
  if (a.decisionToken && a.proposalId) rememberToken(a.proposalId, a.decisionToken);
  const cur = a.currency;
  const root = h('div', { class: 'result' });
  root.append(verdictBanner(a), h('div', { class: 'grid3 cards3' }, summaryCards(a)));
  if (a.briefing) root.append(h('div', { class: 'panel note-panel' }, h('h3', {}, 'Agent’s note ', h('span', { class: 'pill blue' }, 'Gemini')), h('p', {}, a.briefing), h('p', { class: 'muted xs' }, 'Written by the model from the computed numbers. Every figure in it is checked against those numbers; a note with any other figure is discarded.')));
  const ladder = priceLadder(a);
  if (ladder) root.append(h('section', { class: 'card' }, h('h3', {}, 'Price ladder'), h('p', { class: 'muted sm' }, `Landed cost of every offer that matched the product. Amber bars are prices not trusted${a.retailCents ? '; the dashed bar is the retail price Gemini recalls' : ''}.`), ladder));
  const g = a.gate;
  const total = Math.max(g.considered, 1);
  const split = h('div', { class: 'split', 'aria-hidden': 'true' }, [['a', g.identical], ['b', g.different], ['c', g.uncertain]].map(([c, n]) => { const i = h('i', { class: String(c) }); i.style.width = `${(Number(n) / total) * 100}%`; return i; }));
  root.append(h('section', { class: 'card' }, h('h3', {}, 'Identity gate'), h('p', { class: 'muted sm' }, `${int(g.considered)} listings checked by Gemini: ${g.identical} identical, ${g.different} different, ${g.uncertain} uncertain.`), split,
    h('h4', { class: 'sec-h' }, 'Passed as identical'),
    h('div', { class: 'offers' }, a.identical.length ? a.identical.map((p: any) => offerRow(p, cur, 'identical')) : h('p', { class: 'muted sm' }, 'None. The gate would rather say no than guess.')),
    (a.flagged ?? []).length ? [h('h4', { class: 'sec-h' }, 'Same product, price not trusted'), h('div', { class: 'offers' }, a.flagged.map((p: any) => offerRow(p, cur, 'flagged')))] : null,
    h('details', { class: 'more' }, h('summary', {}, `Rejected listings (${g.different + g.uncertain}) — why they did not pass`), h('div', { class: 'offers' }, a.rejected.map((p: any) => offerRow(p, cur, 'rejected'))))));
  if (a.proposalId) root.append(h('section', { class: 'card' }, h('h3', {}, 'Needs your approval'), approvalPanel(a.proposalId, opts.onDecision)));
  const s = a.assumptions;
  const dl = h('button', { class: 'btn ghost', type: 'button', on: { click: () => {
    const blob = new Blob([JSON.stringify(a, null, 2)], { type: 'application/json' });
    const link = h('a', { href: URL.createObjectURL(blob), download: `skudesk-${a.id}.json` });
    document.body.append(link); link.click(); link.remove();
  } } }, 'Download the evidence (JSON)');
  root.append(h('details', { class: 'card more' }, h('summary', {}, 'Assumptions and caveats'), h('ul', {}, a.notes.map((n: string) => h('li', {}, n))),
    h('p', { class: 'muted sm' }, `Defaults: marketplace fee ${pct(s.marketplaceFeeBps)}, return reserve ${pct(s.returnReserveBps)}, outbound shipping ${money(s.outboundShippingCents, cur)}, unknown inbound shipping ${money(s.unknownShippingCents, cur)}, margin floor ${pct(s.minMarginBps)}.`),
    h('div', { class: 'actions' }, dl)));
  return root;
}

export { verdictPill };
