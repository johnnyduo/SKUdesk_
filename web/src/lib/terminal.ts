import { $, api, h, int, money, safeLink, thumbSrc, verdictLabel, when } from './client.ts';
import { createChart, type Pt } from './chart.ts';
import { DEVICES, deviceForQuery, deviceLine, type Device } from './devices.ts';
import { JOURNEY } from './journey.ts';
import { createViewer, type Viewer } from './product3d.ts';
import { approvalPanel } from './analysis-view.ts';
import { createRunPanel, streamAnalysis } from './run-panel.ts';
import { createPicker, type PickItem } from './picker.ts';
import { createPhotoViewer, type PhotoViewer } from './photo3d.ts';
import { average, bidsFor, providerOf, vsAvg, winner } from './book.ts';

// The market terminal: product dropdown, stats strip, price chart, an offer book with each buyer agent's bid, a buy ticket, scan clock and tape.
// Every number comes from stored checks. SKUdesk never trades; the ticket files a proposal that a person approves.

type Row = any; // /api/products row
type Lot = { analysis: any; series: any[] };

const POLL_MS = 20000;
const code = (query: string): string => query.match(/\b\d{4,6}\b/)?.[0] ?? query.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
const pctStr = (p: number): string => `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
const dirOf = (p: number): string => (p > 0.005 ? 'up' : p < -0.005 ? 'down' : 'flat');
const ageText = (iso: string): string => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `checked ${s}s ago`;
  if (s < 3600) return `checked ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `checked ${Math.floor(s / 3600)} h ago`;
  return `checked ${Math.floor(s / 86400)} d ago`;
};

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
  let prevKeys: Set<string> | null = null; // what the book showed last time, so rows that changed flash
  let prevFor = '';
  let viewer: Viewer | null = null;
  let want3d: 'model' | 'photo' = 'photo';
  const liveBox = h('div', { class: 'mk-tkt-m', 'aria-live': 'polite' });

  // ── static frame ──
  const chart = createChart({ points: [], currency: 'USD', mode });
  const picker = createPicker((id) => { const d = DEVICES.find((x) => x.symbol === id); if (d) selectDevice(d); else selectProduct(id); });
  const el = {
    live: h('span', { class: 'mk-live', role: 'status' }, h('i', { 'aria-hidden': 'true' }), 'connecting'),
    list: h('div', { class: 'mk-al', role: 'list' }),
    devices: h('div', { class: 'mk-al', role: 'list' }),
    devHead: h('div', { class: 'mk-ph' }, h('h2', {}, 'Not checked yet')),
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
  el.chartp.append(
    h('div', { class: 'mk-ph mk-ctl' }, h('h2', {}, 'Price'), el.seg, h('span', { class: 'mk-ctl-sp' }),
      h('span', { class: 'mk-legends' }, h('span', { class: 'mk-legend' }, h('i', { class: 'mk-sw' }), 'Cheapest identical, landed'), h('span', { class: 'mk-legend' }, h('i', { class: 'mk-sw mk-sw-ref' }), 'Retail (recalled)'))),
    chart.el, el.cap);
  const segBtn = (m: 'line' | 'candles', label: string): HTMLElement => h('button', { type: 'button', 'aria-pressed': String(mode === m), on: { click: () => { mode = m; paintSeg(); paintChart(); } } }, label);
  const paintSeg = (): void => el.seg.replaceChildren(segBtn('line', 'Line'), segBtn('candles', 'Daily candles'));
  paintSeg();

  const tabs = h('nav', { class: 'mk-tabs', 'aria-label': 'Terminal sections' }, h('div', { class: 'mk-tl', role: 'tablist' },
    [['chart', 'Chart'], ['book', 'Book'], ['trades', 'Trades'], ['assets', 'Assets']].map(([k, l]) => h('button', { type: 'button', role: 'tab', 'data-tab': k, class: k === tab ? 'on' : '', 'aria-selected': String(k === tab), on: { click: () => { tab = k; root.dataset.tab = k; tabs.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', (b as HTMLElement).dataset.tab === k); b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === k)); }); } } }, l))));

  const top = h('header', { class: 'mk-top' },
    h('a', { class: 'mk-brand', href: '/', 'aria-label': 'SKUdesk home' }, h('span', { class: 'logo-mark' }, '▲'), h('b', {}, 'SKUdesk')),
    h('nav', { class: 'mk-links', 'aria-label': 'Steps' }, JOURNEY.map((j) => h('a', { href: j.href, 'aria-current': j.href === '/market/' ? 'page' : undefined, class: j.href === '/market/' ? 'on' : '' }, `${j.n} ${j.label}`))),
    h('span', { class: 'mk-sp' }), el.live,
    h('button', { type: 'button', class: 'mk-q', 'aria-label': 'How this market works', on: { click: () => { el.help.hidden = false; } } }, '?'));
  top.querySelector('.logo-mark')!.innerHTML = '<svg width="16" height="16" viewBox="0 0 32 32" aria-hidden="true"><path d="M8 22 16 8l8 14" stroke="#CCFF00" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const note = h('div', { class: 'mk-note' }, h('h1', { class: 'mk-h1' }, 'Market'), h('span', { class: 'mk-pill' }, 'Asking prices'),
    h('span', {}, 'Offers from Google Shopping, judged by Gemini. SKUdesk never trades: the ticket files a proposal and a person approves it.'),
    h('button', { type: 'button', class: 'mk-link', on: { click: () => { el.help.hidden = false; } } }, 'How it works'));

  const body = h('div', { class: 'mk-body' },
    h('div', { class: 'mk-col mk-col-l' }, el.p3d, el.facts,
      h('section', { class: 'mk-panel', 'data-panel': 'assets', 'aria-label': 'Checked products' }, h('div', { class: 'mk-ph' }, h('h2', {}, 'Checked products')), el.list,
        el.devHead, el.devices)),
    h('div', { class: 'mk-col mk-col-c' }, el.stats, el.chartp, el.recent),
    h('div', { class: 'mk-col mk-col-r' }, el.clock, el.book, el.tape));

  const foot = h('footer', { class: 'mk-foot-bar' }, h('span', {}, 'Prices are asking prices from Google Shopping, not retail prices and not sold prices.'), ...JOURNEY.map((j) => h('a', { href: j.href }, j.label)));
  el.help.append(h('div', { class: 'mk-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How this market works' },
    h('div', { class: 'mk-dialog-h' }, h('h2', {}, 'How this market works'), h('button', { type: 'button', class: 'mk-x', 'aria-label': 'Close', on: { click: () => { el.help.hidden = true; } } }, '×')),
    h('p', { class: 'mk-dialog-lead' }, 'This is not an exchange. It is a view of ', h('b', {}, 'identical offers'), ' for each product, with the history of the cheapest one.'),
    h('ol', { class: 'mk-steps' },
      ...[['The book', 'Asks are the identical offers sellers want, dearest at the top and the best ask next to the spread. Bids are what each buyer agent could pay and still clear its margin floor after fees, returns and postage. A deal needs a bid at or above the best ask. Amber rows matched the product but the price cannot be believed.'], ['The chart', 'The cheapest identical landed price at each check. Daily candles group the checks of one day. The bars underneath count identical offers.'], ['The ticket', 'Shows what a buy would cost, what a resale would keep and whether the per-buy limit allows it. "Check live" runs a fresh check.'], ['The clock', 'Cloud Scheduler re-checks the watchlist once a day. Each scan adds a point to the history.']].map(([t, p], i) => h('li', {}, h('span', { class: 'mk-stepn' }, i + 1), h('div', {}, h('h3', {}, t), h('p', {}, p))))),
    h('div', { class: 'mk-dialog-f' }, h('button', { type: 'button', class: 'mk-btn mk-btn-pri', on: { click: () => { el.help.hidden = true; } } }, 'Got it'))));
  root.dataset.tab = tab;
  root.replaceChildren(top, note, h('div', { class: 'mk-pickbar' }, picker.el), h('main', { class: 'mk-main', id: 'main' }, body), tabs, foot, el.help);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') el.help.hidden = true; });

  // ── paint ──
  const cur = (): string => lot?.analysis.currency ?? rows.find((r) => r.key === selKey)?.currency ?? 'USD';

  // A preview whose product has been checked is that product now; only the rest are listed as not checked.
  const unchecked = (): Device[] => DEVICES.filter((d) => !rows.some((r) => r.query.toLowerCase() === d.query.toLowerCase()));

  function paintList(): void {
    const mkRow = (key: string, symbol: string, name: string, price: string, pc: HTMLElement | string, series: (number | null)[], dir: string, on: boolean, click: () => void): HTMLElement =>
      h('button', { type: 'button', class: `mk-ar${on ? ' on' : ''}`, role: 'listitem', 'aria-current': on ? 'true' : undefined, 'data-key': key, on: { click } },
        h('span', { class: 'mk-ar-id' }, h('span', { class: 'mk-ar-sym' }, symbol, on ? h('i', { class: 'mk-act', 'aria-hidden': 'true' }) : null), h('span', { class: 'mk-ar-name' }, name)),
        spark(series, dir), h('span', { class: 'mk-ar-pc' }, h('span', { class: price === 'no offer' ? 'mk-ar-px none' : 'mk-ar-px' }, price), typeof pc === 'string' ? h('span', { class: `mk-ar-ch ${dir}` }, pc) : pc));
    el.list.replaceChildren(...(rows.length ? rows.map((r) => {
      const ch = changeOf(r.series);
      const dir = ch ? dirOf(ch.pct) : 'flat';
      return mkRow(r.key, code(r.query), r.query, r.buy ? money(r.buy.landedCents, r.currency) : 'no offer', ch ? pctStr(ch.pct) : '-', r.series.map((p: any) => p.buyLandedCents), dir, r.key === selKey && !selDevice, () => selectProduct(r.key));
    }) : [h('p', { class: 'mk-none' }, 'No products yet. Run a check on the desk.')]));
    const todo = unchecked();
    el.devHead.hidden = el.devices.hidden = todo.length === 0;
    el.devices.replaceChildren(...todo.map((d) => mkRow(d.symbol, d.symbol, d.name, 'not checked', '-', [], 'flat', selDevice?.symbol === d.symbol, () => selectDevice(d))));
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
    const dev = r ? deviceForQuery(r.query) : undefined;
    const toggle = (): HTMLElement | null => (dev ? h('div', { class: 'mk-seg mk-3dseg', role: 'group', 'aria-label': 'Picture' }, ([['model', '3D model'], ['photo', 'Photo']] as const).map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(want3d === k), 'data-pic': k, on: { click: () => { want3d = k; paintP3d(); } } }, l))) : null);
    if (dev && r && want3d === 'model') {
      photo?.dispose(); photo = null; photoKey = '';
      const shown = { ...dev, symbol: code(r.query), name: r.query, sub: 'Generic 3D model' };
      if (!viewer) viewer = createViewer(shown); else viewer.set(shown);
      el.p3d.replaceChildren(viewer.el, toggle());
      return;
    }
    viewer?.dispose(); viewer = null;
    const src = thumbSrc(r?.thumbnail ?? lot?.analysis.buy?.offer.thumbnail);
    const name = r?.query ?? '';
    const key = `${selKey}|${src ?? ''}`;
    if (photo && photoKey === key && el.p3d.firstElementChild === photo.el && Boolean(el.p3d.querySelector('.mk-3dseg')) === Boolean(dev)) return; // same product: keep the cutout where the person turned it
    photo?.dispose(); photo = null; photoKey = key;
    if (!src) {
      el.p3d.replaceChildren(h('div', { class: 'p3d p3d-photo', role: 'group', 'aria-label': name || 'Product' },
        h('div', { class: 'p3d-glow', 'aria-hidden': 'true' }),
        h('div', { class: 'p3d-top' }, h('div', { class: 'p3d-id' }, h('span', { class: 'p3d-dot', 'aria-hidden': 'true' }), h('span', { class: 'p3d-sym mono' }, r ? code(r.query) : '')), h('div', { class: 'p3d-name' }, name)),
        h('div', { class: 'p3d-bot' }, h('div', { class: 'p3d-hint', 'aria-hidden': 'true' }, 'no photo yet'))));
      return;
    }
    photo = createPhotoViewer(src, r ? code(r.query) : '', name, 'New, sealed');
    el.p3d.replaceChildren(photo.el, toggle());
  }

  const curId = (): string => (selDevice ? selDevice.symbol : selKey);
  function paintPicker(): void {
    const items: PickItem[] = [
      ...rows.map((r): PickItem => { const ch = changeOf(r.series); return { id: r.key, symbol: code(r.query), name: r.query, sub: `${r.market.toUpperCase()} · ${r.identical}/${r.considered} identical`, price: r.buy ? money(r.buy.landedCents, r.currency) : 'no offer', change: ch ? pctStr(ch.pct) : '-', dir: ch ? dirOf(ch.pct) : 'flat', group: 'Checked products' }; }),
      ...unchecked().map((d): PickItem => ({ id: d.symbol, symbol: d.symbol, name: d.name, sub: d.category, price: 'not checked', change: '-', dir: 'flat', group: 'Not checked yet' })),
    ];
    picker.set(items, curId());
  }

  function paintFacts(): void {
    const a = lot?.analysis;
    const pf = (items: [string, string | Node][]): HTMLElement => h('dl', { class: 'mk-pf' }, items.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
    if (selDevice) {
      el.facts.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Facts')), pf([['Category', selDevice.category], ['Checked', 'not yet'], ['Model', '3D preview']]),
        h('p', { class: 'mk-pf-n' }, 'No check has run on this product, so there is no price to show. Run one to see real offers.'));
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
        h('div', { class: 'mk-stat mk-last' }, h('span', { class: 'mk-k' }, 'Cheapest landed'), h('b', { class: 'mk-v mk-none-v' }, 'not checked'), h('span', { class: 'mk-sub' }, 'run a check for real offers')),
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
    const avg = average(a.identical.map((p: any) => p.landedCents));
    const sorted = [...a.identical].sort((x: any, y: any) => x.landedCents - y.landedCents);
    const flaggedAsks = [...(a.flagged ?? [])].sort((x: any, y: any) => x.landedCents - y.landedCents);
    const vsText = (cents: number): HTMLElement => { const v = vsAvg(cents, avg); return h('span', { class: `n mk-vs ${v === null ? '' : dirOf(-v)}` }, v === null ? '-' : pctStr(v)); };
    const keys = new Set<string>();
    const isNew = (k: string): boolean => { keys.add(k); return prevKeys !== null && prevFor === selKey && !prevKeys.has(k); };
    const askRow = (p: any, i: number, flag: boolean): HTMLElement => {
      const depth = h('i', { class: flag ? 'flag' : '' });
      depth.style.width = `${flag ? 100 : ((i + 1) / Math.max(1, sorted.length)) * 100}%`;
      return h('div', { class: `mk-tr mk-bk${i === 0 && !flag ? ' best' : ''}${flag ? ' flag' : ''}${isNew(`a:${p.offer.seller}:${p.landedCents}`) ? ' fresh' : ''}` },
        h('span', { class: `n ${flag ? 'dn' : 'sell'}` }, money(p.landedCents, cc)),
        h('span', { class: 'mk-who', title: `${p.offer.title} (via ${providerOf(p.offer.origin)})` }, p.offer.url ? safeLink(p.offer.url, p.offer.seller) : p.offer.seller, providerOf(p.offer.origin) === 'Google Shopping' ? null : h('small', {}, providerOf(p.offer.origin))),
        flag ? h('span', { class: 'n mk-vs dn' }, 'bad price') : vsText(p.landedCents),
        h('span', { class: 'mk-depth', 'aria-hidden': 'true' }, depth));
    };
    // asks run from dearest at the top to the best ask next to the spread, like a ladder
    const askRows = sorted.map((p: any, i: number) => askRow(p, i, false)).reverse();
    const setAside = flaggedAsks.map((p: any, i: number) => askRow(p, i, true));
    const bids = bidsFor(a, limits?.minMarginBps ?? 1000);
    const win = winner(bids);
    const topBid = bids[0]?.ceilingCents ?? null;
    const bidRows = bids.map((b) => h('div', { class: `mk-tr mk-bid${b.crosses ? ' cross' : ''}${isNew(`b:${b.policy.id}:${b.ceilingCents}`) ? ' fresh' : ''}`, 'data-agent': b.policy.id },
      h('span', { class: 'n buy' }, b.ceilingCents === null ? '-' : money(b.ceilingCents, cc)),
      h('span', { class: 'mk-who', title: b.policy.rule }, b.policy.name, h('small', {}, `${b.policy.rule} · ${(b.floorBps / 100).toFixed(1)}%`)),
      b.ceilingCents === null ? h('span', { class: 'n mk-vs' }, '-') : vsText(b.ceilingCents),
      h('span', { class: `n mk-bid-s ${b.crosses ? 'up' : ''}` }, b.gapPct === null ? 'no room' : b.crosses ? 'takes it' : `ask ${b.gapPct.toFixed(0)}% over`)));
    const best = a.buy;
    const bestPct = best && a.retailCents ? ((best.landedCents - a.retailCents) / a.retailCents) * 100 : null;
    const arb = a.arbitrage;
    const overLimit = best && limits && best.landedCents > limits.maxSpendCents;

    const runBtn = h('button', { type: 'button', class: 'mk-btn mk-btn-pri', on: { click: () => void runLive(a.query, a.market, liveBox, runBtn as HTMLButtonElement) } }, 'Check live');
    const ticket = h('div', { class: 'mk-tkt' },
      h('div', { class: 'mk-tkt-h' }, 'Buy ticket'),
      h('dl', { class: 'mk-pf' },
        ...[['Buy at', best ? `${money(best.landedCents, cc)} · ${best.offer.seller}` : 'no identical offer'], ['Resale reference', arb ? money(arb.sellReference.priceCents, cc) : '-'], ['Net after all costs', arb ? `${money(arb.netCents, cc)} (${(arb.marginBps / 100).toFixed(1)}%)` : '-'], ['Margin floor', limits ? `${(limits.minMarginBps / 100).toFixed(1)}%` : '-'], ['Per-buy limit', best && limits ? (overLimit ? `above the ${money(limits.maxSpendCents, cc)} limit` : `within ${money(limits.maxSpendCents, cc)}`) : '-']]
          .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
      h('div', { class: 'mk-tkt-a' }, runBtn, h('a', { class: 'mk-btn', href: `/app/opportunities/view/?id=${a.id}` }, 'Evidence')), liveBox);
    const spread = best && topBid ? ((best.landedCents - topBid) / topBid) * 100 : null;
    const verdictLine = !bids.length
      ? 'No resale reference yet: the bids need a second identical offer to price a resale.'
      : win
        ? `${win.policy.name} bids ${money(win.ceilingCents!, cc)}, which reaches the best ask. ${bids.find((b) => b.policy.id === 'live')?.crosses ? 'The live agent clears its own margin floor too, so it files a proposal for a person to approve.' : 'Only the looser policies reach it: the live agent keeps its margin floor and files nothing.'}`
        : `No bid reaches the best ask. It sits ${spread === null ? '' : `${spread.toFixed(1)}% `}above the highest bid, because fees, returns and postage take about ${(((a.assumptions.marketplaceFeeBps + a.assumptions.returnReserveBps) / 100)).toFixed(0)}% of a resale.`;
    el.book.replaceChildren(
      h('div', { class: 'mk-ph' }, h('h2', {}, 'Offer book'), h('span', { class: 'mk-ph-r', 'data-age': a.createdAt, 'data-testid': 'book-age' }, ageText(a.createdAt))),
      h('div', { class: 'mk-th mk-bkh' }, h('span', {}, 'Landed'), h('span', {}, 'Seller'), h('span', {}, 'vs avg'), h('span', {}, 'Depth')),
      h('div', { class: 'mk-sidehead' }, 'Asks: what sellers want, via Google Shopping'),
      h('div', { class: 'mk-tbody mk-asks' }, askRows.length ? askRows : [h('p', { class: 'mk-none' }, 'No offer passed the identity gate. The gate would rather say no than guess.')]),
      h('div', { class: 'mk-spread', 'data-testid': 'spread' }, h('span', {}, 'Average ', h('b', { class: 'n' }, avg === null ? '-' : money(avg, cc))), h('span', {}, 'Best ask ', h('b', { class: 'n' }, best ? money(best.landedCents, cc) : '-')), h('span', {}, 'Top bid ', h('b', { class: 'n' }, topBid === null ? '-' : money(topBid, cc))), h('span', {}, 'Gap ', h('b', { class: 'n' }, spread === null ? '-' : `${spread.toFixed(1)}%`))),
      h('div', { class: 'mk-sidehead' }, 'Bids: what each agent will pay'),
      h('div', { class: 'mk-tbody mk-bids', 'data-testid': 'bids' }, bidRows.length ? bidRows : [h('p', { class: 'mk-none' }, 'Waiting for a second identical offer.')]),
      h('p', { class: 'mk-bk-verdict' }, verdictLine),
      setAside.length ? h('div', { class: 'mk-sidehead' }, 'Set aside by the identity gate') : null,
      setAside.length ? h('div', { class: 'mk-tbody' }, setAside) : null,
      h('div', { class: 'mk-bk-sum' }, best ? h('span', {}, 'Best ask ', h('b', { class: 'n' }, money(best.landedCents, cc)), bestPct === null ? '' : ` · ${pctStr(bestPct)} vs retail`) : h('span', {}, 'No best ask'), h('span', { class: 'dim' }, `${a.identical.length} identical · ${(a.flagged ?? []).length} set aside`)),
      ticket);
    prevKeys = keys; prevFor = selKey;
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

  const paintAll = (): void => { paintList(); paintPicker(); paintP3d(); paintFacts(); paintStats(); paintChart(); paintRecent(); paintBook(); paintTape(); paintClock(); };

  // ── data ──
  async function loadLot(): Promise<void> {
    lot = selKey && !selDevice ? await api<Lot>(`/api/lots/${selKey}`).catch(() => null) : null;
  }
  async function refresh(): Promise<void> {
    const [r, ev, sc, lim] = await Promise.all([api<Row[]>('/api/products').catch(() => rows), api<any[]>('/api/events').catch(() => events), api<any[]>('/api/scans').catch(() => scans), api('/api/limits').catch(() => limits)]);
    rows = r.sort((x, y) => y.identical - x.identical || y.considered - x.considered);
    events = ev; scans = sc; limits = lim;
    // Open on the product with the longest price history, so the chart has something to show.
    if (!selDevice && (!selKey || !rows.some((x) => x.key === selKey))) selKey = [...rows].sort((x, y) => y.series.filter((p: any) => p.buyLandedCents !== null).length - x.series.filter((p: any) => p.buyLandedCents !== null).length || y.identical - x.identical)[0]?.key ?? '';
    await loadLot();
    paintAll();
  }
  function selectProduct(key: string): void {
    selDevice = null; selKey = key; lastPrice = null; liveBox.replaceChildren();
    { const row = rows.find((x) => x.key === key); want3d = row && DEVICES.some((d) => d.query.toLowerCase() === row.query.toLowerCase()) ? 'model' : 'photo'; }
    history.replaceState(null, '', `?key=${key}`);
    paintAll();
    void loadLot().then(paintAll);
    if (matchMedia('(max-width:1099px)').matches) { tab = 'chart'; root.dataset.tab = 'chart'; tabs.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', (b as HTMLElement).dataset.tab === 'chart'); }); }
  }
  function selectDevice(d: Device): void {
    selDevice = d; lot = null; lastPrice = null; liveBox.replaceChildren();
    history.replaceState(null, '', `?device=${d.symbol}`);
    paintAll();
  }

  const q = new URLSearchParams(location.search);
  const wantDevice = DEVICES.find((d) => d.symbol === q.get('device'));
  if (wantDevice) selDevice = wantDevice;
  if (q.get('key')) selKey = q.get('key')!;
  void api('/api/status').then((s) => { status = s; });
  void refresh();
  setInterval(() => void refresh(), POLL_MS);
  setInterval(() => { paintClock(); el.book.querySelectorAll<HTMLElement>('[data-age]').forEach((n) => { n.textContent = ageText(n.dataset.age!); }); }, 1000);
  void $;
  void deviceLine;
  void flashClass;
  void status;
}
