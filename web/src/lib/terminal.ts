import { $, api, h, int, money, safeLink, thumbSrc, verdictLabel, when } from './client.ts';
import { createChart, type Pt } from './chart.ts';
import { DEVICES, deviceLine, type Device } from './devices.ts';
import { createViewer, type Viewer } from './product3d.ts';
import { createPhotoViewer, type PhotoViewer } from './photo3d.ts';
import { approvalPanel } from './analysis-view.ts';
import { createRunPanel, streamAnalysis } from './run-panel.ts';
import { createPicker, type PickItem } from './picker.ts';
import { createPractice, type PracticeItem } from './practice-view.ts';
import { dayRound, roundOf } from './practice.ts';

// The market terminal: product list, stats strip, price chart, offer book with an order ticket, clock and tape.
// Two views of the same page. "Practice rounds" is a simulation (practice.ts): a book that moves every round, with four paper agents.
// "Real checks" is stored data only. SKUdesk never trades; the ticket files a proposal that a person approves.

type Row = any; // /api/products row
type Lot = { analysis: any; series: any[] };

const POLL_MS = 20000;
const code = (query: string): string => query.match(/\b\d{4,6}\b/)?.[0] ?? query.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
const pctStr = (p: number): string => `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
const dirOf = (p: number): string => (p > 0.005 ? 'up' : p < -0.005 ? 'down' : 'flat');

function spark(values: (number | null)[], dir: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const v = values.filter((x): x is number => x !== null);
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 52 20'); svg.setAttribute('width', '52'); svg.setAttribute('height', '20'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', v.length < 2 ? 'mk-spark mk-spark-none' : `mk-spark mk-spark-${dir}`);
  const pl = document.createElementNS(ns, 'polyline');
  pl.setAttribute('fill', 'none'); pl.setAttribute('stroke-width', '1.4');
  if (v.length < 2) pl.setAttribute('points', '1,10 51,10');
  else {
    const lo = Math.min(...v), hi = Math.max(...v), s = Math.max(hi - lo, 1);
    pl.setAttribute('points', v.map((y, i) => `${1 + (i / (v.length - 1)) * 50},${18 - ((y - lo) / s) * 16}`).join(' '));
  }
  svg.append(pl);
  return svg;
}

const changeOf = (series: any[]): { pct: number; span: number } | null => {
  const s = series.filter((p) => p.buyLandedCents !== null);
  if (s.length < 2) return null;
  const a = s[0].buyLandedCents, b = s.at(-1).buyLandedCents;
  return { pct: ((b - a) / a) * 100, span: s.length - 1 };
};

export function mountTerminal(root: HTMLElement): void {
  const qs = new URLSearchParams(location.search);
  let view: 'practice' | 'real' = qs.get('view') === 'real' ? 'real' : 'practice';
  let rows: Row[] = [];
  let selKey = '';
  let selDevice: Device | null = null;
  let lot: Lot | null = null;
  let events: any[] = [];
  let scans: any[] = [];
  let limits: any = null;
  let status: any = null;
  let mode: 'line' | 'candles' = 'line';
  let tab = 'chart';
  let lastPrice: number | null = null;
  let viewer: Viewer | null = null;
  const liveBox = h('div', { class: 'mk-tkt-m', 'aria-live': 'polite' });

  // ── static frame ──
  const chart = createChart({ points: [], currency: 'USD', mode });
  const legend = h('span', { class: 'mk-legends' });
  const paintLegend = (): void => legend.replaceChildren(h('span', { class: 'mk-legend' }, h('i', { class: 'mk-sw' }), view === 'practice' ? 'Cheapest identical, landed (simulated)' : 'Cheapest identical, landed'), h('span', { class: 'mk-legend' }, h('i', { class: 'mk-sw mk-sw-ref' }), view === 'practice' ? 'Reference price' : 'Retail (recalled)'));
  const el = {
    live: h('span', { class: 'mk-live', role: 'status' }, h('i', { 'aria-hidden': 'true' }), 'connecting'),
    list: h('div', { class: 'mk-al', role: 'list' }),
    devices: h('div', { class: 'mk-al', role: 'list' }),
    p3d: h('div', { class: 'mk-panel mk-p3d o2', 'data-panel': 'assets' }),
    facts: h('section', { class: 'mk-panel', 'data-panel': 'assets', 'aria-label': 'Product facts' }),
    stats: h('section', { class: 'mk-panel mk-stats', 'data-panel': 'all', 'aria-label': 'Summary' }),
    chartp: h('section', { class: 'mk-panel mk-chartp', 'data-panel': 'chart', 'aria-label': 'Price chart' }),
    recent: h('section', { class: 'mk-panel', 'data-panel': 'trades', 'aria-label': 'Recent checks' }),
    clock: h('section', { class: 'mk-panel mk-clockp o1', 'data-panel': 'book', 'aria-label': 'Scan clock' }),
    book: h('section', { class: 'mk-panel mk-bookp o2', 'data-panel': 'book', 'aria-label': 'Offer book' }),
    tape: h('section', { class: 'mk-panel mk-tape', 'data-panel': 'trades', 'aria-label': 'Tape' }),
    cap: h('div', { class: 'mk-cap' }),
    seg: h('div', { class: 'mk-seg', role: 'group', 'aria-label': 'Chart type' }),
    help: h('div', { class: 'mk-modal', hidden: true }),
  };
  const practice = createPractice({ stats: el.stats, facts: el.facts, recent: el.recent, clock: el.clock, book: el.book, tape: el.tape, cap: el.cap }, chart, { mode: () => mode, onChange: () => { paintList(); paintPicker(); }, toReal: () => setView('real') });
  const picker = createPicker((id) => { const d = DEVICES.find((x) => x.symbol === id); if (d) selectDevice(d); else selectProduct(id); });
  el.chartp.append(
    h('div', { class: 'mk-ph mk-ctl' }, h('h2', {}, 'Price'), el.seg, practice.rangeSeg, h('span', { class: 'mk-ctl-sp' }), legend),
    chart.el, el.cap);
  const segBtn = (m: 'line' | 'candles', label: string): HTMLElement => h('button', { type: 'button', 'aria-pressed': String(mode === m), on: { click: () => { mode = m; paintSeg(); if (view === 'practice') practice.paintChart(); else paintChart(); } } }, label);
  const paintSeg = (): void => el.seg.replaceChildren(segBtn('line', 'Line'), segBtn('candles', 'Daily candles'));
  paintSeg();

  const tabs = h('nav', { class: 'mk-tabs', 'aria-label': 'Terminal sections' }, h('div', { class: 'mk-tl', role: 'tablist' },
    [['chart', 'Chart'], ['book', 'Book'], ['trades', 'Trades'], ['assets', 'Assets']].map(([k, l]) => h('button', { type: 'button', role: 'tab', 'data-tab': k, class: k === tab ? 'on' : '', 'aria-selected': String(k === tab), on: { click: () => { tab = k; root.dataset.tab = k; tabs.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', (b as HTMLElement).dataset.tab === k); b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === k)); }); } } }, l))));

  const top = h('header', { class: 'mk-top' },
    h('a', { class: 'mk-brand', href: '/', 'aria-label': 'SKUdesk home' }, h('span', { class: 'logo-mark' }, '▲'), h('b', {}, 'SKUdesk')),
    h('nav', { class: 'mk-links', 'aria-label': 'Site' }, h('a', { href: '/app/' }, '1 Desk'), h('a', { href: '/show/' }, '2 Agent decision'), h('a', { href: '/app/create/' }, 'Next: 4 Deploy agent →')),
    h('span', { class: 'mk-sp' }), el.live,
    h('button', { type: 'button', class: 'mk-q', 'aria-label': 'How this market works', on: { click: () => { el.help.hidden = false; } } }, '?'));
  top.querySelector('.logo-mark')!.innerHTML = '<svg width="16" height="16" viewBox="0 0 32 32" aria-hidden="true"><path d="M8 22 16 8l8 14" stroke="#CCFF00" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const pill = h('span', { class: 'mk-pill' });
  const noteText = h('span', { class: 'mk-note-t' });
  const viewSeg = h('div', { class: 'mk-seg mk-viewseg', role: 'group', 'aria-label': 'Market view' });
  const note = h('div', { class: 'mk-note' }, h('h1', { class: 'mk-h1' }, 'Market'), pill, noteText,
    h('button', { type: 'button', class: 'mk-link', on: { click: () => { el.help.hidden = false; } } }, 'How it works'));
  const pickBar = h('div', { class: 'mk-pickbar' }, picker.el, viewSeg);
  function paintView(): void {
    root.dataset.view = view;
    pill.textContent = view === 'practice' ? 'Simulated' : 'Asking prices';
    pill.className = view === 'practice' ? 'mk-pill mk-pill-sim' : 'mk-pill';
    noteText.textContent = view === 'practice'
      ? 'Practice rounds: a simulated book that moves every 6 seconds, traded by four paper agents. No offer here is real. Switch to Real checks for live data.'
      : 'Offers from Google Shopping, judged by Gemini. SKUdesk never trades: the ticket files a proposal and a person approves it.';
    viewSeg.replaceChildren(...([['practice', 'Practice rounds'], ['real', 'Real checks']] as const).map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(view === k), 'data-view': k, on: { click: () => setView(k) } }, l)));
    practice.rangeSeg.hidden = view !== 'practice';
    el.seg.hidden = false;
    paintLegend();
    if (view === 'practice') el.live.className = 'mk-live sim';
  }

  const body = h('div', { class: 'mk-body' },
    h('div', { class: 'mk-col mk-col-l' }, el.p3d, el.facts,
      h('section', { class: 'mk-panel', 'data-panel': 'assets', 'aria-label': 'Checked products' }, h('div', { class: 'mk-ph' }, h('h2', {}, 'Checked products')), el.list,
        h('div', { class: 'mk-ph' }, h('h2', {}, 'Reference products')), el.devices)),
    h('div', { class: 'mk-col mk-col-c' }, el.stats, el.chartp, el.recent),
    h('div', { class: 'mk-col mk-col-r' }, el.clock, el.book, el.tape));

  const foot = h('footer', { class: 'mk-foot-bar' }, h('span', {}, 'Prices are asking prices from Google Shopping, not retail prices and not sold prices.'), h('a', { href: '/app/' }, 'Desk'), h('a', { href: '/show/' }, 'Agent decision'), h('a', { href: '/app/create/' }, 'Next: Deploy agent'));
  el.help.append(h('div', { class: 'mk-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How this market works' },
    h('div', { class: 'mk-dialog-h' }, h('h2', {}, 'How this market works'), h('button', { type: 'button', class: 'mk-x', 'aria-label': 'Close', on: { click: () => { el.help.hidden = true; } } }, '×')),
    h('p', { class: 'mk-dialog-lead' }, 'This is not an exchange. It shows the ', h('b', {}, 'identical offers'), ' for a product, either as a simulated practice book or as the real checks the agent has run.'),
    h('ol', { class: 'mk-steps' },
      ...[['The book', 'Every offer Gemini judged to be the same product, cheapest first. Amber rows matched the product but the price cannot be believed.'], ['The chart', 'The cheapest identical landed price at each check. Daily candles group the checks of one day. The bars underneath count identical offers.'], ['The ticket', 'Shows what a buy would cost, what a resale would keep and whether the per-buy limit allows it. "Check live" runs a fresh check.'], ['The clock', 'Real checks: Cloud Scheduler re-checks the watchlist once a day and each scan adds a point. Practice rounds: a new simulated round every 6 seconds.'], ['Practice rounds', 'A simulated book around a real price or a list price. Four paper agents with different rules trade it with the same fee maths as the live agent. It is there to show how the agent decides, not to quote prices.']].map(([t, p], i) => h('li', {}, h('span', { class: 'mk-stepn' }, i + 1), h('div', {}, h('h3', {}, t), h('p', {}, p))))),
    h('div', { class: 'mk-dialog-f' }, h('button', { type: 'button', class: 'mk-btn mk-btn-pri', on: { click: () => { el.help.hidden = true; } } }, 'Got it'))));
  root.dataset.tab = tab;
  root.replaceChildren(top, note, pickBar, h('main', { class: 'mk-main', id: 'main' }, body), tabs, foot, el.help);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') el.help.hidden = true; });

  // ── paint ──
  const cur = (): string => lot?.analysis.currency ?? rows.find((r) => r.key === selKey)?.currency ?? 'USD';

  function paintList(): void {
    const mkRow = (key: string, symbol: string, name: string, price: string, pc: HTMLElement | string, series: (number | null)[], dir: string, on: boolean, click: () => void): HTMLElement =>
      h('button', { type: 'button', class: `mk-ar${on ? ' on' : ''}`, role: 'listitem', 'aria-current': on ? 'true' : undefined, 'data-key': key, on: { click } },
        h('span', { class: 'mk-ar-id' }, h('span', { class: 'mk-ar-sym' }, symbol, on ? h('i', { class: 'mk-act', 'aria-hidden': 'true' }) : null), h('span', { class: 'mk-ar-name' }, name)),
        spark(series, dir), h('span', { class: 'mk-ar-pc' }, h('span', { class: price === 'no offer' ? 'mk-ar-px none' : 'mk-ar-px' }, price), typeof pc === 'string' ? h('span', { class: `mk-ar-ch ${dir}` }, pc) : pc));
    const practiceView = view === 'practice';
    el.list.replaceChildren(...(rows.length ? rows.map((r) => {
      if (practiceView) {
        if (!practice.has(r.key)) return mkRow(r.key, code(r.query), r.query, 'no offer', '-', [], 'flat', r.key === selKey && !selDevice, () => selectProduct(r.key));
        const q = practice.quote(r.key);
        return mkRow(r.key, code(r.query), r.query, q.price, q.ch, q.spark, q.dir, r.key === selKey && !selDevice, () => selectProduct(r.key));
      }
      const ch = changeOf(r.series);
      const dir = ch ? dirOf(ch.pct) : 'flat';
      return mkRow(r.key, code(r.query), r.query, r.buy ? money(r.buy.landedCents, r.currency) : 'no offer', ch ? pctStr(ch.pct) : '-', r.series.map((p: any) => p.buyLandedCents), dir, r.key === selKey && !selDevice, () => selectProduct(r.key));
    }) : [h('p', { class: 'mk-none' }, 'No products yet. Run a check on the desk.')]));
    el.devices.replaceChildren(...DEVICES.map((d) => {
      if (practiceView) { const q = practice.quote(d.symbol); return mkRow(d.symbol, d.symbol, d.name, q.price, q.ch, q.spark, q.dir, selDevice?.symbol === d.symbol, () => selectDevice(d)); }
      return mkRow(d.symbol, d.symbol, d.name, money(d.listCents), 'list', [], 'flat', selDevice?.symbol === d.symbol, () => selectDevice(d));
    }));
  }

  const curId = (): string => (selDevice ? selDevice.symbol : selKey);
  function paintPicker(): void {
    let items: PickItem[];
    if (view === 'practice') items = practice.pickItems();
    else {
      items = [
        ...rows.map((r): PickItem => { const ch = changeOf(r.series); return { id: r.key, symbol: code(r.query), name: r.query, sub: `${r.market.toUpperCase()} · ${r.identical}/${r.considered} identical`, price: r.buy ? money(r.buy.landedCents, r.currency) : 'no offer', change: ch ? pctStr(ch.pct) : '-', dir: ch ? dirOf(ch.pct) : 'flat', group: 'Checked products' }; }),
        ...DEVICES.map((d): PickItem => ({ id: d.symbol, symbol: d.symbol, name: d.name, sub: d.category, price: money(d.listCents), change: 'list', dir: 'flat', group: 'Reference products' })),
      ];
    }
    picker.set(items, curId());
  }

  let photo: PhotoViewer | null = null;
  let photoKey = '';
  function paintP3d(): void {
    const r = rows.find((x) => x.key === selKey);
    if (selDevice) {
      photo?.dispose(); photo = null; photoKey = '';
      if (!viewer) { viewer = createViewer(selDevice); } else viewer.set(selDevice);
      if (el.p3d.firstElementChild !== viewer.el) el.p3d.replaceChildren(viewer.el);
      return;
    }
    viewer = null;
    const src = thumbSrc(r?.thumbnail ?? lot?.analysis.buy?.offer.thumbnail);
    const name = r?.query ?? '';
    const key = `${selKey}|${src ?? ''}`;
    if (photo && photoKey === key && el.p3d.firstElementChild === photo.el) return; // same product, keep the card where the person turned it
    photo?.dispose(); photo = null; photoKey = key;
    if (!src) {
      el.p3d.replaceChildren(h('div', { class: 'p3d p3d-photo', role: 'group', 'aria-label': name || 'Product' },
        h('div', { class: 'p3d-glow', 'aria-hidden': 'true' }),
        h('div', { class: 'p3d-top' }, h('div', { class: 'p3d-id' }, h('span', { class: 'p3d-dot', 'aria-hidden': 'true' }), h('span', { class: 'p3d-sym mono' }, r ? code(r.query) : '')), h('div', { class: 'p3d-name' }, name)),
        h('div', { class: 'p3d-bot' }, h('div', { class: 'p3d-hint', 'aria-hidden': 'true' }, 'no photo yet'))));
      return;
    }
    photo = createPhotoViewer(src, r ? code(r.query) : '', name, 'Sealed set');
    el.p3d.replaceChildren(photo.el);
  }

  function paintFacts(): void {
    const a = lot?.analysis;
    const pf = (items: [string, string | Node][]): HTMLElement => h('dl', { class: 'mk-pf' }, items.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
    if (selDevice) {
      el.facts.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Facts')), pf([['Category', selDevice.category], ['US list price', money(selDevice.listCents)], ['Model', 'generic silhouette']]),
        h('p', { class: 'mk-pf-n' }, 'A reference product with no live check yet. The list price is a reference, not a quote.'));
      return;
    }
    if (!a) { el.facts.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Facts')), h('p', { class: 'mk-none' }, 'Select a product.')); return; }
    el.facts.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Facts'), h('span', { class: 'mk-ph-r' }, a.market.toUpperCase())),
      pf([['Last check', when(a.createdAt)], ['Listings judged', int(a.gate.considered)], ['Identical', int(a.gate.identical)], ['Set aside (bad price)', int(a.flagged?.length ?? 0)], ['Retail (recalled)', a.retailCents ? money(a.retailCents, a.currency) : '-'], ['Verdict', verdictLabel(a.arbitrage ? (a.arbitrage.implausible ? 'unverified' : a.arbitrage.verdict) : a.buy ? 'no-reference' : 'none')]]),
      h('p', { class: 'mk-pf-n' }, 'Prices are asking prices. The retail figure is recalled by Gemini, not a live quote.'));
  }

  const flashClass = (): string => '';
  function paintStats(): void {
    const cc = cur();
    if (selDevice) {
      el.stats.replaceChildren(h('div', { class: 'mk-id' }, h('h2', {}, h('i', { class: 'mk-sw' }), selDevice.symbol), h('span', { class: 'mk-nm' }, selDevice.name)),
        h('div', { class: 'mk-stat mk-last' }, h('span', { class: 'mk-k' }, 'List price'), h('b', { class: 'mk-v n' }, money(selDevice.listCents)), h('span', { class: 'mk-sub' }, 'reference, not a quote')),
        ...['Change', 'High', 'Low', 'Identical', 'Checks'].map((k) => h('div', { class: 'mk-stat' }, h('span', { class: 'mk-k' }, k), h('b', { class: 'mk-v mk-none-v' }, '-'), h('span', { class: 'mk-sub' }, 'no check yet'))));
      return;
    }
    const r = rows.find((x) => x.key === selKey);
    const a = lot?.analysis;
    if (!r || !a) { el.stats.replaceChildren(h('p', { class: 'mk-none' }, 'Select a product.')); return; }
    const pts = (lot?.series ?? []).filter((p) => p.buyLandedCents !== null);
    const ys = pts.map((p) => p.buyLandedCents as number);
    const last = a.buy?.landedCents ?? null;
    const ch = changeOf(lot?.series ?? []);
    const dir = ch ? dirOf(ch.pct) : 'flat';
    const priceNode = h('b', { class: `mk-v n ${dir}`, 'data-testid': 'last-price' }, last !== null ? money(last, cc) : 'no identical offer');
    if (last === null) priceNode.className = 'mk-v mk-none-v';
    if (lastPrice !== null && last !== null && last !== lastPrice) priceNode.classList.add(last > lastPrice ? 'fl-up' : 'fl-dn');
    lastPrice = last;
    const spread = a.buy && a.retailCents ? ((a.buy.landedCents - a.retailCents) / a.retailCents) * 100 : null;
    const stat = (k: string, v: string, sub: string, cls = ''): HTMLElement => h('div', { class: 'mk-stat' }, h('span', { class: 'mk-k' }, k), h('b', { class: `mk-v n ${cls}` }, v), h('span', { class: 'mk-sub' }, sub));
    el.stats.replaceChildren(
      h('div', { class: 'mk-id' }, h('h2', {}, h('i', { class: 'mk-sw' }), code(r.query)), h('span', { class: 'mk-nm', title: r.query }, r.query)),
      h('div', { class: 'mk-stat mk-last' }, h('span', { class: 'mk-k' }, 'Cheapest landed'), priceNode, h('span', { class: 'mk-sub' }, a.buy ? `at ${a.buy.offer.seller}` : 'nothing provably the same')),
      stat('Change', ch ? pctStr(ch.pct) : '-', ch ? `over ${ch.span} check${ch.span === 1 ? '' : 's'}` : 'needs 2 checks', dir),
      stat('High', ys.length ? money(Math.max(...ys), cc) : '-', ys.length ? 'in the history' : 'no history'),
      stat('Low', ys.length ? money(Math.min(...ys), cc) : '-', ys.length ? 'in the history' : 'no history'),
      stat('vs retail', spread === null ? '-' : pctStr(spread), 'cheapest vs recalled retail', spread === null ? '' : dirOf(-spread)),
      stat('Identical', `${a.gate.identical}/${a.gate.considered}`, 'offers that passed the gate'),
      h('p', { class: 'mk-psrc' }, `Last check ${when(a.createdAt)}. ${a.headline}`));
  }

  function paintChart(): void {
    const a = lot?.analysis;
    if (selDevice || !a) {
      chart.update({ points: [], currency: 'USD', mode });
      el.cap.textContent = selDevice ? 'A reference product has no price history. Run a check to start one.' : '';
      return;
    }
    const points: Pt[] = (lot?.series ?? []).map((p) => ({ t: p.t, y: p.buyLandedCents, v: p.identical }));
    chart.update({ points, currency: a.currency, refCents: a.retailCents, mode });
    el.cap.textContent = `${points.filter((p) => p.y !== null).length} price points. The daily scan adds one each day and every check you run adds one. Bars show how many offers passed the identity gate.`;
  }

  function paintRecent(): void {
    const s = [...(lot?.series ?? [])].reverse().slice(0, 14);
    const a = lot?.analysis;
    el.recent.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Recent checks'), h('span', { class: 'mk-ph-r' }, a ? a.currency : '')),
      s.length ? h('div', { class: 'mk-tscroll' }, h('table', { class: 'mk-tbl' },
        h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Time'), h('th', { class: 'r' }, 'Cheapest landed'), h('th', { class: 'r' }, 'Cheapest price'), h('th', { class: 'r' }, 'Identical'))),
        h('tbody', {}, s.map((p, i, arr) => {
          const prev = arr[i + 1]?.buyLandedCents;
          const d = p.buyLandedCents !== null && prev ? dirOf(((p.buyLandedCents - prev) / prev) * 100) : 'flat';
          return h('tr', { class: p.buyLandedCents === null ? 'nt' : '' }, h('td', { class: 'l mono' }, when(p.t)), h('td', { class: `r n ${d}` }, p.buyLandedCents === null ? '-' : money(p.buyLandedCents, a.currency)), h('td', { class: 'r n' }, p.lowestAskCents === null ? '-' : money(p.lowestAskCents, a.currency)), h('td', { class: 'r n' }, `${p.identical}/${p.considered}`));
        })))) : h('p', { class: 'mk-none' }, 'No checks recorded for this product yet.'));
  }

  function paintClock(): void {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    const left = next.getTime() - now.getTime();
    const hh = String(Math.floor(left / 3600000)).padStart(2, '0'), mm = String(Math.floor((left % 3600000) / 60000)).padStart(2, '0'), ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    const pctDone = 100 - (left / 86400000) * 100;
    const lastScan = scans[0];
    const bar = h('i', {});
    bar.style.width = `${pctDone.toFixed(1)}%`;
    el.clock.dataset.built = 'r';
    el.clock.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Scan clock'), h('span', { class: 'mk-ph-r' }, limits?.paused ? 'PAUSED' : 'daily 02:00 UTC')),
      h('div', { class: 'mk-clk' }, h('div', { class: 'mk-clk-t n' }, `${hh}:${mm}:${ss}`), h('div', { class: 'mk-clk-s' }, limits?.paused ? 'The agent is paused by its owner.' : 'until the next scheduled scan'), h('div', { class: 'mk-clk-bar', 'aria-hidden': 'true' }, bar),
        h('div', { class: 'mk-clk-s' }, lastScan ? `Last scan ${when(lastScan.createdAt)}, ${lastScan.done.length} checked` : 'No scan has run yet')));
    el.live.className = `mk-live${limits?.paused ? ' bad' : ''}`;
    el.live.replaceChildren(h('i', { 'aria-hidden': 'true' }), limits?.paused ? 'Agent paused' : `Live · next scan ${hh}:${mm}:${ss}`);
  }

  function paintBook(): void {
    const a = lot?.analysis;
    if (selDevice || !a) {
      el.book.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Offer book')), h('p', { class: 'mk-none' }, selDevice ? 'No live check for this reference product yet.' : 'Select a product.'),
        selDevice ? h('div', { class: 'mk-tkt' }, h('a', { class: 'mk-btn mk-btn-pri', href: `/app/?q=${encodeURIComponent(selDevice.query)}` }, 'Check live offers')) : null);
      return;
    }
    const cc = a.currency;
    const asks = [...a.identical.map((p: any) => ({ p, flag: false })), ...(a.flagged ?? []).map((p: any) => ({ p, flag: true }))].sort((x, y) => x.p.landedCents - y.p.landedCents);
    const max = Math.max(1, ...asks.map((x) => x.p.landedCents));
    let cum = 0;
    const bestAt = asks.findIndex((x) => !x.flag);
    const bookRows = asks.map(({ p, flag }, i) => {
      if (!flag) cum++;
      const depth = h('i', { class: flag ? 'flag' : '' });
      depth.style.width = `${((flag ? 1 : cum) / Math.max(1, a.identical.length)) * 100}%`;
      return h('div', { class: `mk-tr mk-bk${i === bestAt ? ' best' : ''}${flag ? ' flag' : ''}` },
        h('span', { class: `n ${flag ? 'dn' : 'sell'}` }, money(p.landedCents, cc)),
        h('span', { class: 'mk-who', title: p.offer.title }, p.offer.url ? safeLink(p.offer.url, p.offer.seller) : p.offer.seller),
        h('span', { class: 'mk-depth', 'aria-hidden': 'true' }, depth),
        h('span', { class: 'n mk-sz' }, flag ? 'bad price' : p.quoted?.idQuote ? `#${p.quoted.idQuote}` : ''));
    });
    const best = a.buy;
    const bestPct = best && a.retailCents ? ((best.landedCents - a.retailCents) / a.retailCents) * 100 : null;
    const arb = a.arbitrage;
    const overLimit = best && limits && best.landedCents > limits.maxSpendCents;

    const runBtn = h('button', { type: 'button', class: 'mk-btn mk-btn-pri', on: { click: () => void runLive(a.query, a.market, liveBox, runBtn as HTMLButtonElement) } }, 'Check live');
    const ticket = h('div', { class: 'mk-tkt' },
      h('div', { class: 'mk-tkt-h' }, 'Buy ticket'),
      h('dl', { class: 'mk-pf' },
        ...[['Buy at', best ? `${money(best.landedCents, cc)} · ${best.offer.seller}` : 'no identical offer'], ['Resale reference', a.sell ? money(a.sell.listAtCents, cc) : '-'], ['Net after all costs', arb ? `${money(arb.netCents, cc)} (${(arb.marginBps / 100).toFixed(1)}%)` : '-'], ['Margin floor', limits ? `${(limits.minMarginBps / 100).toFixed(1)}%` : '-'], ['Per-buy limit', best && limits ? (overLimit ? `above the ${money(limits.maxSpendCents, cc)} limit` : `within ${money(limits.maxSpendCents, cc)}`) : '-']]
          .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
      h('div', { class: 'mk-tkt-a' }, runBtn, h('a', { class: 'mk-btn', href: `/app/opportunities/view/?id=${a.id}` }, 'Evidence')), liveBox);
    el.book.replaceChildren(
      h('div', { class: 'mk-ph' }, h('h2', {}, 'Offer book'), h('span', { class: 'mk-ph-r' }, code(a.query))),
      h('div', { class: 'mk-th mk-bkh' }, h('span', {}, 'Landed'), h('span', {}, 'Seller'), h('span', {}, 'Depth'), h('span', {}, 'Evidence')),
      h('div', { class: 'mk-tbody' }, bookRows.length ? bookRows : [h('p', { class: 'mk-none' }, 'No offer passed the identity gate. The gate would rather say no than guess.')]),
      h('div', { class: 'mk-bk-sum' }, best ? h('span', {}, 'Best ask ', h('b', { class: 'n' }, money(best.landedCents, cc)), bestPct === null ? '' : ` · ${pctStr(bestPct)} vs retail`) : h('span', {}, 'No best ask'), h('span', { class: 'dim' }, `${a.identical.length} identical · ${(a.flagged ?? []).length} set aside`)),
      ticket);
    void max;
  }

  async function runLive(query: string, market: string, msg: HTMLElement, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    const panel = createRunPanel();
    msg.replaceChildren(panel.el);
    panel.start();
    try {
      const a = await streamAnalysis(query, market, (ev) => panel.handle(ev));
      panel.finish();
      if (a.decisionToken && a.proposalId) (await import('./client.ts')).rememberToken(a.proposalId, a.decisionToken);
      msg.replaceChildren(h('p', { class: 'mk-tkt-ok' }, a.headline), a.proposalId ? approvalPanel(a.proposalId, () => void refresh()) : h('p', { class: 'muted sm' }, 'No proposal was filed.'));
      await refresh();
    } catch (e) {
      msg.replaceChildren(h('p', { class: 'alert' }, (e as Error).message));
    } finally {
      btn.disabled = false;
    }
  }

  function paintTape(): void {
    el.tape.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Tape'), h('span', { class: 'mk-ph-r' }, 'checks, scans and decisions')),
      h('div', { class: 'mk-th' }, h('span', {}, 'Time'), h('span', {}, 'Kind'), h('span', {}, 'Event'), h('span', {}, ''), h('span', {}, '')),
      h('div', { class: 'mk-tbody' }, events.length ? events.slice(0, 40).map((e) => h('div', { class: 'mk-tr mk-ev', title: e.detail ?? '' },
        h('span', { class: 'mono dim' }, new Date(e.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })), h('span', { class: `mk-kind ${e.kind}` }, e.kind), h('span', { class: 'mk-who' }, e.title))) : [h('p', { class: 'mk-none' }, 'No activity yet.')]));
  }

  function ensureSelection(): void {
    if (view !== 'practice' || selDevice) return;
    if (selKey && practice.has(selKey)) return;
    const first = rows.find((r) => practice.has(r.key));
    if (first) { selKey = first.key; return; }
    selKey = '';
    selDevice = DEVICES.find((d) => d.symbol === 'IP18P') ?? DEVICES[0];
  }
  const paintLive = (): void => {
    if (view !== 'practice') return;
    el.live.className = 'mk-live sim';
    el.live.replaceChildren(h('i', { 'aria-hidden': 'true' }), `Simulated · round ${dayRound(roundOf(Date.now())).toLocaleString('en-US')}`);
  };
  const paintAll = (): void => {
    ensureSelection();
    paintList(); paintPicker(); paintP3d();
    if (view === 'practice') {
      if (practice.selected() !== curId()) practice.select(curId());
      practice.paint(); paintLive();
    } else {
      paintFacts(); paintStats(); paintChart(); paintRecent(); paintBook(); paintTape(); paintClock();
    }
  };

  const CLASS_OF: [RegExp, string][] = [[/iphone|galaxy|pixel|phone/i, 'Phones'], [/airpods|headphone|earbud|buds|speaker/i, 'Audio'], [/playstation|ps5|xbox|switch|nintendo|console/i, 'Gaming'], [/macbook|laptop|ipad|tablet/i, 'Computing'], [/watch/i, 'Wearables'], [/\bcase\b|cover/i, 'Accessories']];
  const STREET: Record<string, number> = { Accessories: 0.9, Audio: 0.93, Phones: 0.95, Gaming: 0.96, Computing: 0.94, Wearables: 0.93 };
  function practiceItems(): PracticeItem[] {
    const checked = rows.filter((r) => r.buy).map((r): PracticeItem => ({
      key: r.key, symbol: code(r.query), name: r.query, currency: r.currency, fairCents: r.buy.landedCents, retailCents: r.retailCents ?? null, offers: r.identical,
      category: CLASS_OF.find(([re]) => re.test(r.query))?.[1] ?? 'Sets', group: 'Checked products', sub: `${r.market.toUpperCase()} · built on a real check`, basis: 'check',
    }));
    const devs = DEVICES.map((d): PracticeItem => ({
      key: d.symbol, symbol: d.symbol, name: d.name, currency: 'USD', fairCents: Math.round(d.listCents * (STREET[d.category] ?? 0.94)), retailCents: d.listCents,
      category: d.category, group: 'Reference products', sub: `${d.category} · built on the list price`, basis: 'list',
    }));
    return [...checked, ...devs];
  }

  // ── data ──
  async function loadLot(): Promise<void> {
    lot = selKey && !selDevice ? await api<Lot>(`/api/lots/${selKey}`).catch(() => null) : null;
  }
  async function refresh(): Promise<void> {
    const [r, ev, sc, lim] = await Promise.all([api<Row[]>('/api/products').catch(() => rows), api<any[]>('/api/events').catch(() => events), api<any[]>('/api/scans').catch(() => scans), api('/api/limits').catch(() => limits)]);
    rows = r.sort((x, y) => y.identical - x.identical || y.considered - x.considered);
    events = ev; scans = sc; limits = lim;
    practice.setItems(practiceItems());
    // Real view opens on the product with the longest price history, so the chart has something to show.
    if (view === 'real' && !selDevice && (!selKey || !rows.some((x) => x.key === selKey))) selKey = [...rows].sort((x, y) => y.series.filter((p: any) => p.buyLandedCents !== null).length - x.series.filter((p: any) => p.buyLandedCents !== null).length || y.identical - x.identical)[0]?.key ?? '';
    ensureSelection();
    await loadLot();
    paintAll();
  }
  function syncUrl(): void {
    const p = new URLSearchParams();
    if (view === 'real') p.set('view', 'real');
    if (selDevice) p.set('device', selDevice.symbol); else if (selKey) p.set('key', selKey);
    history.replaceState(null, '', p.size ? `?${p}` : location.pathname);
  }
  function toChartTab(): void {
    if (matchMedia('(max-width:1099px)').matches) { tab = 'chart'; root.dataset.tab = 'chart'; tabs.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', (b as HTMLElement).dataset.tab === 'chart'); }); }
  }
  function selectProduct(key: string): void {
    selDevice = null; selKey = key; lastPrice = null; liveBox.replaceChildren();
    syncUrl();
    void loadLot().then(paintAll);
    paintAll();
    toChartTab();
  }
  function selectDevice(d: Device): void {
    selDevice = d; lot = null; lastPrice = null; liveBox.replaceChildren();
    syncUrl();
    paintAll();
    toChartTab();
  }
  function setView(v: 'practice' | 'real'): void {
    if (v === view) return;
    view = v; lastPrice = null;
    el.live.className = 'mk-live';
    syncUrl();
    paintView();
    paintAll();
  }

  const wantDevice = DEVICES.find((d) => d.symbol === qs.get('device'));
  if (wantDevice) selDevice = wantDevice;
  if (qs.get('key')) selKey = qs.get('key')!;
  paintView();
  void api('/api/status').then((s) => { status = s; });
  void refresh();
  setInterval(() => void refresh(), POLL_MS);
  let beat = 0;
  setInterval(() => {
    if (view === 'practice') { if (practice.tick()) { paintLive(); paintList(); paintPicker(); } } else if (++beat % 4 === 0) paintClock();
  }, 250);
  void $;
  void deviceLine;
  void flashClass;
  void status;
}
