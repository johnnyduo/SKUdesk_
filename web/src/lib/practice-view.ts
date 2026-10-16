import { h, money } from './client.ts';
import type { Pt, Mark } from './chart.ts';
import { AGENT_RULES, FEE_BPS, dayRound, ROUNDS_PER_DAY, RESERVE_BPS, ROUND_MS, createEngine, fiveMinuteMovePct, minutesPerGap, profileFor, roundOf, seriesOf, type Engine, type LogRow, type ProfileInput } from './practice.ts';
import type { PickItem } from './picker.ts';

// The practice side of the market page: panels painted from the round-by-round simulation in practice.ts.
// Nothing painted here is a real offer. The page says so in several places, and this file never uses the word "live" for a price.

export interface PracticeItem extends ProfileInput { group: string; sub: string; basis: 'check' | 'list' }
export const RANGES: [string, number][] = [['5m', 50], ['15m', 150], ['1h', 600], ['6h', 3600]];

const pctStr = (p: number): string => `${p > 0 ? '+' : ''}${p.toFixed(2)}%`;
const dirOf = (p: number): string => (p > 0.005 ? 'up' : p < -0.005 ? 'down' : 'flat');
const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export interface PanelSet { stats: HTMLElement; facts: HTMLElement; recent: HTMLElement; clock: HTMLElement; book: HTMLElement; tape: HTMLElement; cap: HTMLElement }
export interface ChartLike { update(o: { points: Pt[]; currency: string; refCents?: number | null; mode: 'line' | 'candles'; bucketMs?: number; live?: boolean; marks?: Mark[]; volName?: string; refLabel?: string }): void }

export function createPractice(panels: PanelSet, chart: ChartLike, opts: { mode(): 'line' | 'candles'; onChange(): void; toReal(): void }) {
  let items: PracticeItem[] = [];
  let sel = '';
  let range = 150;
  const engines = new Map<string, Engine>();
  const profileKeys = new Map<string, string>();
  let lastAsk: number | null = null;
  let paintedN = -1;
  let queue: string[] = [];
  let queueTimer = 0;
  const code = h('div', { class: 'mk-clk-t n' }, '0:06');
  const bar = h('i', {});
  const phaseEls = ['Collect offers', 'Judge identity', 'Decide'].map((l) => h('span', {}, l));
  const phaseText = h('div', { class: 'mk-clk-s' });
  const roundLabel = h('span', { class: 'mk-ph-r n' });

  const sig = (it: PracticeItem): string => `${it.key}|${it.fairCents}|${it.retailCents ?? ''}|${it.offers ?? ''}`;
  function build(id: string, now = Date.now()): Engine | null {
    const it = items.find((x) => x.key === id);
    if (!it || !(it.fairCents > 0)) return null;
    const have = engines.get(id);
    if (have && profileKeys.get(id) === sig(it)) { have.advanceTo(roundOf(now)); return have; }
    const e = createEngine(profileFor(it), now);
    engines.set(id, e); profileKeys.set(id, sig(it));
    return e;
  }
  const engine = (): Engine | null => build(sel);

  function warm(): void {
    clearTimeout(queueTimer);
    const next = queue.shift();
    if (!next) return;
    queueTimer = window.setTimeout(() => { build(next); opts.onChange(); warm(); }, 30);
  }

  function changeOver(e: Engine, count: number): { pct: number; hi: number; lo: number; first: number } | null {
    const s = e.rounds.filter((r) => r.ask !== null).slice(-count);
    if (s.length < 2) return null;
    const ys = s.map((r) => r.ask!);
    return { pct: ((ys[ys.length - 1] - ys[0]) / ys[0]) * 100, hi: Math.max(...ys), lo: Math.min(...ys), first: ys[0] };
  }

  function sparkPoints(e: Engine): string | undefined {
    const s = seriesOf(e, 150, 26);
    if (s.length < 2) return undefined;
    const lo = Math.min(...s.map((x) => x.y)), hi = Math.max(...s.map((x) => x.y)), span = Math.max(hi - lo, 1);
    return s.map((x, i) => `${1 + (i / (s.length - 1)) * 50},${18 - ((x.y - lo) / span) * 16}`).join(' ');
  }

  /** Price, change and sparkline for the product lists. A product without an engine yet shows its fair value. */
  function quote(id: string): { price: string; ch: string; dir: string; spark: (number | null)[]; sparkPts?: string } {
    const it = items.find((x) => x.key === id);
    const e = engines.get(id);
    if (!it) return { price: '-', ch: '-', dir: 'flat', spark: [] };
    if (!e) return { price: money(it.fairCents, it.currency), ch: '-', dir: 'flat', spark: [] };
    const last = e.rounds[e.rounds.length - 1];
    const c = changeOver(e, 150);
    return { price: last?.ask ? money(last.ask, it.currency) : '-', ch: c ? pctStr(c.pct) : '-', dir: c ? dirOf(c.pct) : 'flat', spark: seriesOf(e, 150, 26).map((x) => x.y), sparkPts: sparkPoints(e) };
  }

  function pickItems(): PickItem[] {
    return items.map((it) => { const q = quote(it.key); return { id: it.key, symbol: it.symbol, name: it.name, sub: it.sub, price: q.price, change: q.ch, dir: q.dir, group: it.group, spark: q.sparkPts }; });
  }

  const rangeSeg = h('div', { class: 'mk-seg', role: 'group', 'aria-label': 'Time range' });
  function paintRange(): void {
    rangeSeg.replaceChildren(...RANGES.map(([l, n]) => h('button', { type: 'button', 'aria-pressed': String(range === n), on: { click: () => { range = n; paintRange(); paint(); } } }, l)));
  }
  paintRange();

  // ── panels ──
  function paintStats(e: Engine): void {
    const p = e.profile, cc = p.currency;
    const last = e.rounds[e.rounds.length - 1];
    const c = changeOver(e, range);
    const dir = c ? dirOf(c.pct) : 'flat';
    const spread = last.ask ? ((last.ask - p.retailCents) / p.retailCents) * 100 : null;
    const priceNode = h('b', { class: `mk-v n ${dir}`, 'data-testid': 'last-price' }, last.ask ? money(last.ask, cc) : 'no identical offer');
    if (lastAsk !== null && last.ask !== null && last.ask !== lastAsk) priceNode.classList.add(last.ask > lastAsk ? 'fl-up' : 'fl-dn');
    lastAsk = last.ask;
    const stat = (k: string, v: string, sub: string, cls = ''): HTMLElement => h('div', { class: 'mk-stat' }, h('span', { class: 'mk-k' }, k), h('b', { class: `mk-v n ${cls}` }, v), h('span', { class: 'mk-sub' }, sub));
    const label = RANGES.find(([, n]) => n === range)?.[0] ?? '';
    panels.stats.replaceChildren(
      h('div', { class: 'mk-id' }, h('h2', {}, h('i', { class: 'mk-sw' }), p.symbol), h('span', { class: 'mk-nm', title: p.name }, p.name)),
      h('div', { class: 'mk-stat mk-last' }, h('span', { class: 'mk-k' }, 'Cheapest landed'), priceNode, h('span', { class: 'mk-sub' }, last.ask ? `at ${last.askSeller}` : 'nothing provably the same')),
      stat('Change', c ? pctStr(c.pct) : '-', `over ${label}`, dir),
      stat('High', c ? money(c.hi, cc) : '-', `in ${label}`),
      stat('Low', c ? money(c.lo, cc) : '-', `in ${label}`),
      stat('vs ref.', spread === null ? '-' : pctStr(spread), 'cheapest vs the reference', spread === null ? '' : dirOf(-spread)),
      stat('Identical', `${last.identical}/${last.considered}`, 'offers that passed the gate'),
      h('p', { class: 'mk-psrc' }, h('b', { class: 'mk-sim' }, 'Simulated. '), `Round ${dayRound(last.n).toLocaleString('en-US')} of ${ROUNDS_PER_DAY.toLocaleString('en-US')} today. A practice book built around ${items.find((x) => x.key === p.key)?.basis === 'check' ? 'the cheapest price of the latest real check' : 'the list price'}, so the agents have something to trade against. No offer here is real.`));
  }

  function marksFor(e: Engine, from: number): Mark[] {
    return e.log.filter((l) => (l.kind === 'BUY' || l.kind === 'SELL') && l.n >= from).map((l) => ({ t: new Date(l.t).toISOString(), side: l.kind as 'BUY' | 'SELL', label: `${l.agent}: ${l.text}` }));
  }

  function paintChart(): void {
    const e = engine();
    if (!e) return;
    const s = seriesOf(e, range, range > 600 ? 360 : range);
    const from = e.rounds[e.rounds.length - 1].n - range;
    const points: Pt[] = s.map((x) => ({ t: new Date(x.t).toISOString(), y: x.y, v: x.v }));
    const bucket = ROUND_MS * Math.max(1, Math.ceil(range / 50));
    chart.update({ points, currency: e.profile.currency, refCents: e.profile.retailCents, mode: opts.mode(), bucketMs: bucket, live: true, marks: marksFor(e, from), volName: 'Move (bps)', refLabel: 'reference' });
    panels.cap.textContent = 'Simulated rounds every 6 seconds. Triangles are paper trades: up for a buy, down for a sale. A sharp dip is a short-lived listing the agents either take or pass on.';
  }

  function paintFacts(e: Engine): void {
    const p = e.profile;
    const pf = (rows: [string, string][]): HTMLElement => h('dl', { class: 'mk-pf' }, rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
    panels.facts.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Practice facts'), h('span', { class: 'mk-ph-r' }, 'SIMULATED')),
      pf([['Character', p.character], ['Sellers in the book', String(p.sellers.length)], ['Typical 5 min move', `±${fiveMinuteMovePct(p).toFixed(2)}%`], ['A price gap opens', `about every ${minutesPerGap(p)} min`], ['Fair value', money(p.fairCents, p.currency)], ['Reference price', money(p.retailCents, p.currency)], ['Costs agents face', `${((FEE_BPS + RESERVE_BPS) / 100).toFixed(0)}% + postage`]]),
      h('p', { class: 'mk-pf-n' }, 'Each product has its own pace, crowd and gap rate. The costs are the ones the live agent uses, so most small gaps are honest passes.'));
  }

  const kindLabel: Record<string, string> = { BUY: 'buy', SELL: 'sell', DECLINE: 'pass', MISS: 'miss', FLAG: 'flag' };
  function paintTape(e: Engine): void {
    const head = e.rounds[e.rounds.length - 1].n;
    type Row = { n: number; t: number; kind: string; who: string; text: string };
    const rows: Row[] = [];
    for (const l of e.log.slice(-40) as LogRow[]) rows.push({ n: l.n, t: l.t, kind: l.kind, who: l.agent, text: l.text });
    for (const r of e.rounds.slice(-14)) {
      const prev = e.rounds[r.n - e.anchor - 1];
      const d = prev?.ask && r.ask ? ((r.ask - prev.ask) / prev.ask) * 100 : 0;
      rows.push({ n: r.n, t: r.t, kind: 'ROUND', who: `R${r.n % 100000}`, text: r.ask ? `${money(r.ask, e.profile.currency)} ${d === 0 ? '·' : d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(2)}% · ${r.identical} identical${r.flagged ? ` · ${r.flagged} set aside` : ''}` : 'no identical offer' });
    }
    const weight = (r: Row): number => (r.kind === 'ROUND' ? 1 : 0);
    rows.sort((a, b) => b.n - a.n || weight(a) - weight(b) || b.t - a.t);
    panels.tape.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Tape'), h('span', { class: 'mk-ph-r' }, 'rounds and paper trades')),
      h('div', { class: 'mk-th' }, h('span', {}, 'Time'), h('span', {}, 'Kind'), h('span', {}, 'Event'), h('span', {}, ''), h('span', {}, '')),
      h('div', { class: 'mk-tbody', 'data-testid': 'tape' }, rows.slice(0, 44).map((r) => h('div', { class: `mk-tr mk-ev${r.n > paintedN && paintedN >= 0 ? ' fresh' : ''}`, title: r.text },
        h('span', { class: 'mono dim' }, clock(r.t)), h('span', { class: `mk-kind ${r.kind === 'ROUND' ? 'round' : kindLabel[r.kind]}` }, r.kind === 'ROUND' ? 'round' : kindLabel[r.kind]),
        h('span', { class: 'mk-who' }, r.kind === 'ROUND' ? r.text : h('span', {}, h('b', {}, `${r.who} `), r.text))))));
    void head;
  }

  function paintAgents(e: Engine): void {
    const cc = e.profile.currency;
    const rows = e.agents.map((a) => {
      const eq = e.equity(a) - a.startCash;
      return h('tr', { 'data-agent': a.rule.id },
        h('td', { class: 'l' }, h('b', {}, a.rule.name), h('div', { class: 'mk-ag-rule' }, a.rule.rule)),
        h('td', { class: 'r n' }, `${a.lots.length}/${a.rule.maxLots}`),
        h('td', { class: `r n ${dirOf(a.realized)}` }, `${a.realized > 0 ? '+' : ''}${money(a.realized, cc)}`),
        h('td', { class: `r n ${dirOf(eq)}` }, `${eq > 0 ? '+' : ''}${money(eq, cc)}`),
        h('td', { class: 'r n' }, `${a.wins}/${a.losses}/${a.passes}`),
        h('td', { class: 'l mk-ag-now' }, a.stance));
    });
    panels.recent.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Agent desk'), h('span', { class: 'mk-ph-r' }, 'paper money · session since 6 h before 00:00 UTC')),
      h('div', { class: 'mk-tscroll' }, h('table', { class: 'mk-tbl mk-agents', 'data-testid': 'agent-desk' },
        h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Agent'), h('th', { class: 'r' }, 'Open'), h('th', { class: 'r' }, 'Realized'), h('th', { class: 'r' }, 'Equity'), h('th', { class: 'r', title: 'wins / losses / passes' }, 'W / L / pass'), h('th', { class: 'l' }, 'Now'))),
        h('tbody', {}, rows))));
  }

  function paintBook(e: Engine): void {
    const p = e.profile, cc = p.currency;
    const last = e.rounds[e.rounds.length - 1];
    const b = e.book(last.n);
    if (!b) return;
    const ok = b.offers.filter((o) => !o.flagged);
    let cum = 0;
    const bestIdx = b.offers.findIndex((o) => !o.flagged);
    const bookRows = b.offers.map((o, i) => {
      if (!o.flagged) cum++;
      const depth = h('i', { class: o.flagged ? 'flag' : '' });
      depth.style.width = `${((o.flagged ? 1 : cum) / Math.max(1, ok.length)) * 100}%`;
      return h('div', { class: `mk-tr mk-bk${i === bestIdx ? ' best' : ''}${o.flagged ? ' flag' : ''}${o.dip && !o.flagged ? ' dip' : ''}` },
        h('span', { class: `n ${o.flagged ? 'dn' : 'sell'}` }, money(o.landedCents, cc)),
        h('span', { class: 'mk-who' }, o.seller),
        h('span', { class: 'mk-depth', 'aria-hidden': 'true' }, depth),
        h('span', { class: 'n mk-sz' }, o.flagged ? 'bad price' : o.dip ? 'gap' : o.channel === 'marketplace' ? 'market' : 'shop'));
    });
    const best = ok[0], second = ok[1];
    const gapPct = best && second ? ((second.landedCents - best.landedCents) / best.landedCents) * 100 : 0;
    const stances = e.agents.map((a) => h('li', {}, h('b', {}, a.rule.name), ' ', a.stance));
    panels.book.replaceChildren(
      h('div', { class: 'mk-ph' }, h('h2', {}, 'Offer book'), h('span', { class: 'mk-ph-r' }, 'SIMULATED')),
      h('div', { class: 'mk-th mk-bkh' }, h('span', {}, 'Landed'), h('span', {}, 'Seller'), h('span', {}, 'Depth'), h('span', {}, 'Note')),
      h('div', { class: 'mk-tbody' }, bookRows),
      h('div', { class: 'mk-bk-sum' }, best ? h('span', {}, 'Best ask ', h('b', { class: 'n' }, money(best.landedCents, cc)), ` · gap to next ${gapPct.toFixed(1)}%`) : h('span', {}, 'No best ask'), h('span', { class: 'dim' }, `${ok.length} identical · ${b.offers.length - ok.length} set aside`)),
      h('div', { class: 'mk-tkt' },
        h('div', { class: 'mk-tkt-h' }, 'Agents this round'),
        h('ul', { class: 'mk-stances' }, stances),
        h('p', { class: 'mk-tkt-note' }, 'Paper agents trade on their own here. A real buy always waits for a person to approve it.'),
        h('div', { class: 'mk-tkt-a' }, h('button', { type: 'button', class: 'mk-btn mk-btn-pri', on: { click: () => opts.toReal() } }, 'Real checks and live buy ticket'))));
  }

  const PHASES = ['Collecting offers', 'Judging identity', 'Deciding'];
  function mountClock(): void {
    if (panels.clock.dataset.built === 'p') return;
    panels.clock.replaceChildren(h('div', { class: 'mk-ph' }, h('h2', {}, 'Round clock'), roundLabel),
      h('div', { class: 'mk-clk' }, code, phaseText, h('div', { class: 'mk-clk-bar', 'aria-hidden': 'true' }, bar), h('div', { class: 'mk-phases' }, phaseEls), h('div', { class: 'mk-clk-s' }, `A new round every ${ROUND_MS / 1000} seconds. Every viewer sees the same rounds.`)));
    panels.clock.dataset.built = 'p';
  }
  function paintClock(now = Date.now()): void {
    mountClock();
    const n = roundOf(now);
    const into = now - n * ROUND_MS;
    const left = Math.max(0, Math.ceil((ROUND_MS - into) / 1000));
    const ph = into < ROUND_MS * 0.5 ? 0 : into < ROUND_MS * 0.78 ? 1 : 2;
    code.textContent = `0:0${left}`;
    phaseText.textContent = PHASES[ph];
    bar.style.width = `${(into / ROUND_MS) * 100}%`;
    phaseEls.forEach((el, i) => el.classList.toggle('on', i === ph));
    roundLabel.textContent = `round ${dayRound(n).toLocaleString('en-US')} today`;
  }
  function paint(): void {
    const e = engine();
    if (!e) return;
    paintStats(e); paintChart(); paintFacts(e); paintAgents(e); paintBook(e); paintTape(e); paintClock();
    paintedN = e.rounds[e.rounds.length - 1].n;
  }

  return {
    rangeSeg,
    pickItems, quote,
    has: (id: string): boolean => items.some((x) => x.key === id),
    /** Replace the product list. Engines whose inputs did not change are kept. */
    setItems(next: PracticeItem[]): void {
      items = next;
      for (const id of [...engines.keys()]) if (!items.some((x) => x.key === id)) { engines.delete(id); profileKeys.delete(id); }
      queue = items.map((x) => x.key).filter((k) => k !== sel && (!engines.has(k) || profileKeys.get(k) !== sig(items.find((x) => x.key === k)!)));
      warm();
    },
    select(id: string): void { sel = id; lastAsk = null; paintedN = -1; },
    selected: (): string => sel,
    paint,
    paintChart,
    /** Called a few times a second: advance to the current round, repaint once per round, and move the clock. */
    tick(): boolean {
      const n = roundOf(Date.now());
      if (!engine()) return false;
      if (paintedN < n) {
        for (const o of engines.values()) o.advanceTo(n);
        paint();
        return true;
      }
      paintClock();
      return false;
    },
    AGENT_RULES,
  };
}
