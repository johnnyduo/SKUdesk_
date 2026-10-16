import { h, money, pct, thumbSrc } from './client.ts';

type Line = { stage: number; tone: 'info' | 'good' | 'bad' | 'warn'; text: string; offer?: any };

export const STAGE_NAMES = ['Search', 'Identity gate', 'Evidence check', 'Price sanity', 'Economics', 'Proposal'];

// Turns one stored check into the ordered lines the player replays. Everything shown is data from that check.
export function scriptOf(a: any): Line[] {
  const cur = a.currency;
  const L: Line[] = [];
  L.push({ stage: 0, tone: 'info', text: `Searching Google Shopping for “${a.query}” in ${a.market.toUpperCase()}…` });
  L.push({ stage: 0, tone: 'info', text: `${a.searched} listings returned. The agent will judge ${a.gate.considered} of them.` });
  const judged: any[] = [...a.identical, ...(a.flagged ?? []), ...a.rejected];
  for (const p of judged) {
    const o = p.offer;
    const short = o.title.length > 70 ? `${o.title.slice(0, 67)}…` : o.title;
    if (p.verdict === 'identical') L.push({ stage: 1, tone: 'good', offer: o, text: `${o.seller} · “${short}” → IDENTICAL (${Math.round(p.confidence * 100)}%)` });
    else L.push({ stage: 1, tone: p.verdict === 'different' ? 'bad' : 'warn', offer: o, text: `${o.seller} · “${short}” → ${p.verdict.toUpperCase()}${p.mismatches?.[0] ? `: ${p.mismatches[0]}` : ''}` });
  }
  const hidden = a.gate.considered - judged.length;
  if (hidden > 0) L.push({ stage: 1, tone: 'info', text: `…and ${hidden} more rejected listings (only the first ${judged.length} are kept in the record).` });
  L.push({ stage: 1, tone: 'info', text: `Gate result: ${a.gate.identical} identical, ${a.gate.different} different, ${a.gate.uncertain} uncertain.` });
  for (const p of a.identical.concat(a.flagged ?? [])) {
    const q = p.quoted;
    L.push({ stage: 2, tone: q?.brandQuote && q?.idQuote ? 'good' : 'warn', offer: p.offer, text: q?.brandQuote ? `Evidence for ${p.offer.seller}: brand “${q.brandQuote}” and number “${q.idQuote}” are in the listing text. Verified by code.` : `${p.offer.seller}: no quoted evidence on record.` });
  }
  for (const p of a.identical.concat(a.flagged ?? [])) {
    if (p.visual) L.push({ stage: 2, tone: p.visual.verdict === 'matches' ? 'good' : 'warn', offer: p.offer, text: `Photo from ${p.offer.seller}: Gemini sees ${p.visual.seen.replace(/[.]$/, '')}. ${p.visual.verdict === 'matches' ? 'It agrees with the text.' : 'Not enough to settle it, so the text verdict stands.'}` });
  }
  for (const p of a.rejected) {
    const m = (p.mismatches ?? []).find((x: string) => x.startsWith('photo:'));
    if (m) L.push({ stage: 2, tone: 'bad', offer: p.offer, text: `Dropped after the photo check, ${p.offer.seller}: ${m.slice(6).trim()}` });
  }
  if (!a.identical.length && !(a.flagged ?? []).length) L.push({ stage: 2, tone: 'info', text: 'Nothing passed the gate, so there is no evidence to check.' });
  if (a.retailCents) L.push({ stage: 3, tone: 'info', text: `Gemini recalls a retail price of ${money(a.retailCents, cur)}. This is recalled knowledge, not a live quote.` });
  for (const f of a.flagged ?? []) L.push({ stage: 3, tone: 'warn', offer: f.offer, text: `Set aside: ${f.offer.seller} at ${money(f.offer.priceCents, cur)} is ${f.reason === 'retail' ? 'under half of the recalled retail price' : 'under 40% of the median identical price'}. Treated as a data error.` });
  if (!(a.flagged ?? []).length) L.push({ stage: 3, tone: 'good', text: 'Every matching price is believable.' });
  if (a.buy) {
    L.push({ stage: 4, tone: 'good', offer: a.buy.offer, text: `Cheapest identical: ${a.buy.offer.seller}, ${money(a.buy.landedCents, cur)} landed${a.buy.shippingAssumed ? ' (shipping assumed)' : ''}.` });
    if (a.sell) L.push({ stage: 4, tone: 'info', text: `Price to match when selling: ${money(a.sell.listAtCents, cur)}; you keep ${money(a.sell.netBeforeCostCents, cur)} before your purchase cost.` });
    if (a.arbitrage) L.push({ stage: 4, tone: a.arbitrage.verdict === 'profitable' && !a.arbitrage.implausible ? 'good' : a.arbitrage.implausible ? 'warn' : 'bad', text: `Arbitrage: ${a.arbitrage.implausible ? 'too good to verify' : a.arbitrage.verdict}. Net ${money(a.arbitrage.netCents, cur)} (${pct(a.arbitrage.marginBps)}) after all costs.` });
    else L.push({ stage: 4, tone: 'info', text: 'No second identical price to resell against, so no arbitrage verdict.' });
  } else L.push({ stage: 4, tone: 'bad', text: 'No identical sealed product found. Nothing to buy or compare.' });
  L.push({ stage: 5, tone: a.proposalId ? 'good' : 'info', text: a.proposalId ? 'Filed a pending proposal. The agent cannot spend; a person must approve it.' : 'No proposal filed.' });
  L.push({ stage: 5, tone: 'info', text: a.headline });
  return L;
}

export function mountPlayer(root: HTMLElement, a: any): void {
  const lines = scriptOf(a);
  let i = 0, timer = 0, speed = 1, playing = false;
  const log = h('div', { class: 'console', role: 'log', 'aria-live': 'off' });
  const steps = STAGE_NAMES.map((n, k) => h('li', { class: 'stage' }, h('b', {}, k + 1), ` ${n}`));
  const card = h('div', { class: 'pl-card' }, h('div', { class: 'thumb lg' }), h('div', { class: 'pl-t' }, h('b', {}, a.query), h('small', { class: 'muted' }, 'Listing under review')));
  const bar = h('div', { class: 'split' }, h('i', { class: 'a' }));
  const playBtn = h('button', { class: 'btn', type: 'button' }, 'Pause');
  const stageNow = (s: number): void => steps.forEach((el, k) => { el.classList.toggle('act', k === s); el.classList.toggle('done', k < s); });
  const show = (n: number): void => {
    const l = lines[n];
    stageNow(l.stage);
    log.append(h('p', { class: `pl-${l.tone}` }, h('span', { class: 'mono xs muted' }, `${String(n + 1).padStart(2, '0')} `), l.text));
    log.scrollTop = log.scrollHeight;
    if (l.offer) {
      const src = thumbSrc(l.offer.thumbnail);
      card.replaceChildren(h('div', { class: 'thumb lg' }, src ? h('img', { src, alt: '' }) : null), h('div', { class: 'pl-t' }, h('b', {}, l.offer.seller), h('small', { class: 'muted' }, l.offer.title.slice(0, 90)), h('span', { class: 'mono' }, money(l.offer.priceCents, a.currency))));
    }
    (bar.firstChild as HTMLElement).style.width = `${((n + 1) / lines.length) * 100}%`;
  };
  const tick = (): void => {
    if (i >= lines.length) { playing = false; playBtn.textContent = 'Replay'; return; }
    show(i++);
    timer = window.setTimeout(tick, (lines[i - 1].stage === 1 ? 260 : 900) / speed);
  };
  const start = (): void => { playing = true; playBtn.textContent = 'Pause'; clearTimeout(timer); tick(); };
  playBtn.addEventListener('click', () => {
    if (i >= lines.length) { log.replaceChildren(); i = 0; start(); return; }
    if (playing) { playing = false; clearTimeout(timer); playBtn.textContent = 'Resume'; } else start();
  });
  const speedSel = h('select', { 'aria-label': 'Speed', on: { change: (e) => { speed = Number((e.target as HTMLSelectElement).value); } } }, [1, 2, 4].map((s) => h('option', { value: s }, `${s}×`)));
  root.replaceChildren(
    h('div', { class: 'grid2 grid-7-5 start' },
      h('section', { class: 'card' }, h('h2', {}, 'The agent’s log'), log, h('div', { class: 'row' }, playBtn, speedSel)),
      h('section', { class: 'card' }, h('h2', {}, 'Now judging'), card, bar, h('ol', { class: 'stages' }, steps))));
  start();
}
