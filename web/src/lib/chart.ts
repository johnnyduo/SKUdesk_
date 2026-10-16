import { h, money, money0 } from './client.ts';

// A price chart in the style of a trading terminal: area line or daily candles, an offers-count histogram underneath,
// a retail reference line, a last-price tag and a crosshair with a tooltip. Plain SVG, no dependencies.

export interface Pt { t: string; y: number | null; v: number }
export interface ChartOpts { points: Pt[]; currency: string; refCents?: number | null; mode: 'line' | 'candles' }

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag: string, attrs: Record<string, string | number> = {}): SVGElement => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

interface Candle { t0: number; t1: number; o: number; h: number; l: number; c: number; v: number; n: number }

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function toCandles(points: Pt[]): Candle[] {
  const out: Candle[] = [];
  let key = '';
  for (const p of points) {
    if (p.y === null) continue;
    const ms = new Date(p.t).getTime();
    const k = dayKey(ms);
    if (k !== key || !out.length) {
      out.push({ t0: ms, t1: ms, o: p.y, h: p.y, l: p.y, c: p.y, v: p.v, n: 1 });
      key = k;
    } else {
      const c = out[out.length - 1];
      c.t1 = ms; c.h = Math.max(c.h, p.y); c.l = Math.min(c.l, p.y); c.c = p.y; c.v = Math.max(c.v, p.v); c.n++;
    }
  }
  return out;
}

const fmtDay = (ms: number): string => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtTime = (ms: number): string => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function createChart(initial: ChartOpts): { el: HTMLElement; update(o: ChartOpts): void } {
  let opts = initial;
  const svg = svgEl('svg', { class: 'mk-svg', role: 'img' }) as SVGSVGElement;
  const tip = h('div', { class: 'mk-tip', hidden: true });
  const empty = h('div', { class: 'mk-empty', hidden: true });
  const el = h('div', { class: 'mk-chart', tabindex: 0, 'aria-label': 'Price chart. Use the left and right arrow keys to move along the history.' }, svg, tip, empty);
  let hover = -1;
  let geom: { xs: number[]; ys: number[]; i0: number; items: { label: string; rows: [string, string][] }[]; W: number; H: number; pad: { l: number; r: number; t: number; b: number }; yOf: (v: number) => number; xOf: (i: number) => number } | null = null;

  function render(): void {
    const W = Math.max(el.clientWidth, 280), H = Math.max(el.clientHeight, 220);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    tip.hidden = true;
    hover = -1;
    const cur = opts.currency;
    const pts = opts.points.filter((p) => p.y !== null);
    if (pts.length === 0) {
      empty.hidden = false;
      empty.replaceChildren(h('b', {}, 'No checks yet'), h('span', {}, 'Run a check on this product and its price starts to build a history here.'));
      geom = null;
      return;
    }
    if (pts.length === 1) {
      empty.hidden = false;
      empty.replaceChildren(h('b', {}, money(pts[0].y!, cur)), h('span', {}, 'One price so far. The daily scan adds a point each day, and every check you run adds one too.'));
      geom = null;
      return;
    }
    empty.hidden = true;

    const pad = { l: 10, r: 74, t: 14, b: 24 };
    const volH = Math.round((H - pad.t - pad.b) * 0.16);
    const plotB = H - pad.b - volH - 6;
    const candles = opts.mode === 'candles' ? toCandles(opts.points) : [];
    const series = opts.mode === 'candles' && candles.length >= 2 ? candles : null;

    const ys = series ? series.flatMap((c) => [c.h, c.l]) : pts.map((p) => p.y!);
    if (opts.refCents) ys.push(opts.refCents);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const span = Math.max(hi - lo, hi * 0.01, 1);
    lo -= span * 0.1; hi += span * 0.1;
    const yOf = (v: number): number => pad.t + (1 - (v - lo) / (hi - lo)) * (plotB - pad.t);
    const n = series ? series.length : pts.length;
    const xOf = (i: number): number => pad.l + (series ? (i + 0.5) / n : i / (n - 1)) * (W - pad.l - pad.r);

    // grid and price axis (right); show cents when the range is tiny so the labels differ
    const fine = hi - lo < 1000;
    const axisMoney = (v: number): string => (fine ? money(v, cur) : money0(v, cur));
    const ticks = 5;
    for (let k = 0; k <= ticks; k++) {
      const v = lo + ((hi - lo) * k) / ticks;
      const y = yOf(v);
      svg.append(svgEl('line', { class: 'mk-grid', x1: pad.l, x2: W - pad.r, y1: y, y2: y }));
      const t = svgEl('text', { class: 'mk-ax', x: W - pad.r + 8, y: y + 4 });
      t.textContent = axisMoney(v);
      svg.append(t);
    }
    // time axis
    const firstMs = series ? series[0].t0 : new Date(pts[0].t).getTime();
    const lastMs = series ? series[n - 1].t1 : new Date(pts[n - 1].t).getTime();
    const sameDay = lastMs - firstMs < 36 * 3600 * 1000;
    const labelCount = Math.max(2, Math.min(5, n, Math.floor((W - pad.l - pad.r) / 100)));
    for (let k = 0; k < labelCount; k++) {
      const i = Math.round((k * (n - 1)) / Math.max(labelCount - 1, 1));
      const ms = series ? series[i].t0 : new Date(pts[i].t).getTime();
      const t = svgEl('text', { class: 'mk-ax mk-ax-s', x: xOf(i), y: H - 6, 'text-anchor': k === 0 ? 'start' : k === labelCount - 1 ? 'end' : 'middle' });
      t.textContent = sameDay ? new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : fmtDay(ms);
      svg.append(t);
    }

    // retail reference
    if (opts.refCents) {
      const y = yOf(opts.refCents);
      svg.append(svgEl('line', { class: 'mk-ref', x1: pad.l, x2: W - pad.r, y1: y, y2: y }));
      const t = svgEl('text', { class: 'mk-ref-t', x: pad.l + 6, y: y - 5 });
      t.textContent = `retail ${money0(opts.refCents, cur)} (recalled)`;
      svg.append(t);
    }

    // histogram of identical offers
    const vmax = Math.max(1, ...(series ? series.map((c) => c.v) : pts.map((p) => p.v)));
    const bw = Math.max(2, Math.min(18, ((W - pad.l - pad.r) / n) * 0.6));
    const vbase = H - pad.b;
    svg.append(svgEl('line', { class: 'mk-vbase', x1: pad.l, x2: W - pad.r, y1: vbase, y2: vbase }));
    const vals = series ? series.map((c) => c.v) : pts.map((p) => p.v);
    vals.forEach((v, i) => {
      const bh = (v / vmax) * volH;
      const up = i === 0 || v >= vals[i - 1];
      svg.append(svgEl('rect', { class: up ? 'mk-vup' : 'mk-vdn', x: xOf(i) - bw / 2, y: vbase - bh, width: bw, height: Math.max(bh, v > 0 ? 1 : 0) }));
    });
    const vl = svgEl('text', { class: 'mk-ax mk-ax-s', x: pad.l + 2, y: vbase - volH - 2 });
    vl.textContent = 'IDENTICAL OFFERS';
    svg.append(vl);

    // price
    let lastClose: number, prevClose: number;
    const xsArr: number[] = [], ysArr: number[] = [];
    let items: { label: string; rows: [string, string][] }[] = [];
    if (series) {
      series.forEach((c, i) => {
        const x = xOf(i);
        const up = c.c >= c.o;
        const g = svgEl('g', { class: up ? 'mk-up' : 'mk-dn' });
        g.append(svgEl('line', { class: 'mk-wick', x1: x, x2: x, y1: yOf(c.h), y2: yOf(c.l) }));
        const top = yOf(Math.max(c.o, c.c)), bot = yOf(Math.min(c.o, c.c));
        g.append(svgEl('rect', { class: 'mk-body', x: x - bw / 2, y: top, width: bw, height: Math.max(bot - top, 1.5) }));
        svg.append(g);
        xsArr.push(x); ysArr.push(yOf(c.c));
      });
      items = series.map((c) => ({ label: fmtDay(c.t0), rows: [['Open', money(c.o, cur)], ['High', money(c.h, cur)], ['Low', money(c.l, cur)], ['Close', money(c.c, cur)], ['Checks', String(c.n)], ['Identical offers', String(c.v)]] }));
      lastClose = series[n - 1].c; prevClose = series[n - 2].c;
    } else {
      const line = pts.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.y!).toFixed(1)}`).join(' ');
      const gradId = `g${Math.random().toString(36).slice(2, 7)}`;
      const defs = svgEl('defs');
      const grad = svgEl('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(svgEl('stop', { offset: 0, 'stop-color': '#CCFF00', 'stop-opacity': 0.22 }), svgEl('stop', { offset: 1, 'stop-color': '#CCFF00', 'stop-opacity': 0 }));
      defs.append(grad);
      svg.append(defs);
      svg.append(svgEl('polygon', { points: `${xOf(0)},${plotB} ${line} ${xOf(n - 1)},${plotB}`, fill: `url(#${gradId})` }));
      svg.append(svgEl('polyline', { class: 'mk-line', fill: 'none', points: line }));
      pts.forEach((p, i) => { xsArr.push(xOf(i)); ysArr.push(yOf(p.y!)); if (n <= 40) svg.append(svgEl('circle', { class: 'mk-dot', cx: xOf(i), cy: yOf(p.y!), r: 2.2 })); });
      items = pts.map((p, i) => ({ label: fmtTime(new Date(p.t).getTime()), rows: [['Cheapest landed', money(p.y!, cur)], ['vs previous', i ? `${p.y! >= pts[i - 1].y! ? '+' : ''}${(((p.y! - pts[i - 1].y!) / pts[i - 1].y!) * 100).toFixed(2)}%` : '-'], ['Identical offers', String(p.v)]] }));
      lastClose = pts[n - 1].y!; prevClose = pts[n - 2].y!;
    }

    // last price line, tag and pulse
    const ly = yOf(lastClose);
    const up = lastClose >= prevClose;
    svg.append(svgEl('line', { class: 'mk-lastline', x1: pad.l, x2: W - pad.r, y1: ly, y2: ly }));
    svg.append(svgEl('rect', { class: up ? 'mk-tag-up' : 'mk-tag-dn', x: W - pad.r + 2, y: ly - 10, width: pad.r - 4, height: 20, rx: 4 }));
    const tg = svgEl('text', { class: 'mk-tagt', x: W - pad.r + 8, y: ly + 4 });
    tg.textContent = fine ? money(lastClose, cur) : money0(lastClose, cur);
    svg.append(tg);
    const lx = xsArr[xsArr.length - 1];
    svg.append(svgEl('circle', { class: 'mk-pulse', cx: lx, cy: ly, r: 4 }), svgEl('circle', { class: 'mk-lastdot', cx: lx, cy: ly, r: 3.5 }));

    // crosshair layer
    const xh = svgEl('g', { class: 'mk-xhg', visibility: 'hidden' });
    const xv = svgEl('line', { class: 'mk-xh', y1: pad.t, y2: vbase });
    const xhh = svgEl('line', { class: 'mk-xh', x1: pad.l, x2: W - pad.r });
    const xd = svgEl('circle', { class: 'mk-xdot', r: 4 });
    const xt = svgEl('rect', { class: 'mk-xtag', x: W - pad.r + 2, width: pad.r - 4, height: 20, rx: 4 });
    const xtt = svgEl('text', { class: 'mk-xtagt', x: W - pad.r + 8 });
    xh.append(xv, xhh, xd, xt, xtt);
    svg.append(xh);

    geom = { xs: xsArr, ys: ysArr, i0: 0, items, W, H, pad, yOf, xOf };
    const values = series ? series.map((c) => c.c) : pts.map((p) => p.y!);

    const show = (i: number): void => {
      if (!geom) return;
      hover = i;
      const x = geom.xs[i], y = geom.ys[i];
      xh.setAttribute('visibility', 'visible');
      xv.setAttribute('x1', String(x)); xv.setAttribute('x2', String(x));
      xhh.setAttribute('y1', String(y)); xhh.setAttribute('y2', String(y));
      xd.setAttribute('cx', String(x)); xd.setAttribute('cy', String(y));
      xt.setAttribute('y', String(y - 10)); xtt.setAttribute('y', String(y + 4));
      xtt.textContent = fine ? money(values[i], cur) : money0(values[i], cur);
      const it = geom.items[i];
      tip.replaceChildren(h('div', { class: 'mk-tip-h' }, it.label), ...it.rows.map(([k, v]) => h('div', { class: 'mk-tip-r' }, h('span', {}, k), h('b', {}, v))));
      tip.hidden = false;
      const left = x + 14 + 190 > W - pad.r ? x - 14 - tip.offsetWidth : x + 14;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${Math.max(4, Math.min(y - 20, H - tip.offsetHeight - 30))}px`;
    };
    const hide = (): void => { xh.setAttribute('visibility', 'hidden'); tip.hidden = true; hover = -1; };
    svg.onpointermove = (ev) => {
      if (!geom) return;
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      let best = 0, bd = Infinity;
      geom.xs.forEach((x, i) => { const d = Math.abs(x - px); if (d < bd) { bd = d; best = i; } });
      show(best);
    };
    svg.onpointerleave = hide;
    el.onkeydown = (ev) => {
      if (!geom) return;
      if (ev.key === 'ArrowLeft') { show(hover < 0 ? geom.xs.length - 1 : Math.max(0, hover - 1)); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { show(hover < 0 ? geom.xs.length - 1 : Math.min(geom.xs.length - 1, hover + 1)); ev.preventDefault(); }
      else if (ev.key === 'Escape') hide();
    };
    el.onblur = hide;
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => render()) : null;
  ro?.observe(el);
  queueMicrotask(render);
  return { el, update(o) { opts = o; render(); } };
}
