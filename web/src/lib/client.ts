// Client-side helpers shared by every page. All listing text is untrusted, so DOM is built with textContent only.
// innerHTML is used solely for our own constant icons.

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
/** replaceChildren that skips null, undefined and false: the DOM would print them as text. */
export const fill = (el: Element, ...kids: (Node | string | null | undefined | false)[]): void => el.replaceChildren(...(kids.filter((k) => k !== null && k !== undefined && k !== false) as (Node | string)[]));
export const reduceMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

type Props = Record<string, unknown> & { on?: Record<string, (e: Event) => void> };
type Kid = Node | string | number | null | undefined | false | Kid[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (kid: Kid): void => {
    if (Array.isArray(kid)) kid.forEach(add);
    else if (kid !== null && kid !== undefined && kid !== false) el.append(typeof kid === 'number' ? String(kid) : kid);
  };
  kids.forEach(add);
  return el;
}

export const money = (cents: number, cur = 'USD'): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(cents / 100);
export const money0 = (cents: number, cur = 'USD'): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(cents / 100);
export const pct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;
export const int = (n: number): string => new Intl.NumberFormat('en-US').format(n);
export const when = (iso: string): string => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function safeLink(url: string, label: Kid, props: Props = {}): HTMLElement {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') return h('a', { href: u.href, target: '_blank', rel: 'noopener noreferrer', ...props }, label);
  } catch { /* fall through */ }
  return h('span', props, label);
}

// Product thumbnails come from Google and eBay hosts. They are fetched through our own allow-listed proxy so the page can run
// under a strict policy and WebGL can use them as textures.
export const thumbSrc = (url: string | null | undefined): string | null => (url ? `/api/img?u=${encodeURIComponent(url)}` : null);

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api<T = any>(path: string, opts: RequestInit & { owner?: boolean } = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  if (opts.owner) { const k = ownerKey(); if (k) headers.set('x-skudesk-owner', k); }
  const res = await fetch(path, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body?.error || `Request failed (${res.status})`, res.status, body);
  return body as T;
}

export const postJson = <T = any>(path: string, data: unknown, opts: { owner?: boolean; method?: string } = {}): Promise<T> =>
  api<T>(path, { method: opts.method ?? 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), owner: opts.owner });

// ── owner key and decision tokens live in sessionStorage only ──
const KEY = 'skudesk.owner';
const TOKENS = 'skudesk.tokens';
const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
export const ownerKey = (): string => safe(() => sessionStorage.getItem(KEY) ?? '', '');
export const setOwnerKey = (k: string): void => safe(() => (k ? sessionStorage.setItem(KEY, k) : sessionStorage.removeItem(KEY)), undefined);
export const rememberToken = (proposalId: string, token: string): void => safe(() => {
  const all = JSON.parse(sessionStorage.getItem(TOKENS) ?? '{}');
  all[proposalId] = token;
  sessionStorage.setItem(TOKENS, JSON.stringify(all));
}, undefined);
export const tokenFor = (proposalId: string): string => safe(() => JSON.parse(sessionStorage.getItem(TOKENS) ?? '{}')[proposalId] ?? '', '');

export async function checkOwner(): Promise<boolean> {
  if (!ownerKey()) return false;
  try { await api('/api/owner/check', { owner: true }); return true; } catch { return false; }
}

export const ICONS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  model: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  verify: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  price: '<path d="M4 18l5-6 4 3 7-9"/><path d="M4 21h16"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 13h2M13 13h2M9 17h2M13 17h2"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M5 21c1-4 4-6 7-6s6 2 7 6"/>',
  limits: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  refuse: '<circle cx="12" cy="12" r="8"/><path d="M9 9l6 6M15 9l-6 6"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
};
export const icon = (name: string): HTMLElement => {
  const s = h('span', { class: 'pf-ic' });
  s.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return s;
};

export function countUp(el: HTMLElement, target: number, fmt: (n: number) => string): void {
  el.textContent = fmt(target);
  if (reduceMotion() || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(el);
      const t0 = performance.now();
      const step = (now: number): void => {
        const p = Math.min(1, (now - t0) / 1100);
        el.textContent = fmt(p >= 1 ? target : Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }, { threshold: 0.6 });
  io.observe(el);
}

export function tile(value: number, label: string, sub?: string, fmt: (n: number) => string = int, good = false): HTMLElement {
  const v = h('b', { class: `tr-v${good ? ' good' : ''}` }, fmt(value));
  countUp(v, value, fmt);
  return h('li', { class: 'tr-tile' }, v, h('span', { class: 'tr-k' }, label), sub ? h('small', { class: 'tr-sub' }, sub) : null);
}

export const verdictLabel = (s: string): string => ({ profitable: 'Arbitrage clears', thin: 'Thin margin', loss: 'No arbitrage', unverified: 'Too good to verify', 'no-reference': 'Nothing to resell against', none: 'No identical product' } as Record<string, string>)[s] ?? s;

export const verdictPill = (s: string): HTMLElement =>
  h('span', { class: `pill ${s === 'profitable' ? 'good' : s === 'thin' || s === 'unverified' ? 'warn' : s === 'loss' ? 'bad' : ''}` }, verdictLabel(s));

// ── a tiny line chart for price history ──
export function lineChart(points: { t: string; y: number | null }[], cur: string, opts: { height?: number } = {}): HTMLElement {
  const data = points.filter((p) => p.y !== null) as { t: string; y: number }[];
  const W = 640, H = opts.height ?? 200, pad = { l: 56, r: 12, t: 12, b: 24 };
  const wrap = h('div', { class: 'chart' });
  if (data.length < 2) {
    wrap.append(h('p', { class: 'muted sm' }, data.length ? `One price point so far (${money(data[0].y, cur)}). The scheduled scan adds one each time it runs, so a trend appears after the next scan.` : 'No price history yet.'));
    return wrap;
  }
  const ys = data.map((d) => d.y);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = Math.max(max - min, 1);
  const x = (i: number): number => pad.l + (i / (data.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number): number => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Price history, from ${money(data[0].y, cur)} to ${money(data.at(-1)!.y, cur)}`);
  const mk = (tag: string, attrs: Record<string, string>): SVGElement => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  for (const v of [min, (min + max) / 2, max]) {
    svg.append(mk('line', { x1: String(pad.l), x2: String(W - pad.r), y1: String(y(v)), y2: String(y(v)), stroke: 'rgba(255,255,255,.08)' }));
    const label = mk('text', { x: String(pad.l - 8), y: String(y(v) + 4), 'text-anchor': 'end', fill: '#8D938B', 'font-size': '11', 'font-family': 'JetBrains Mono, monospace' });
    label.textContent = money0(v, cur);
    svg.append(label);
  }
  svg.append(mk('polyline', { points: data.map((d, i) => `${x(i)},${y(d.y)}`).join(' '), fill: 'none', stroke: '#CCFF00', 'stroke-width': '2', 'stroke-linejoin': 'round' }));
  data.forEach((d, i) => svg.append(mk('circle', { cx: String(x(i)), cy: String(y(d.y)), r: '3', fill: '#CCFF00' })));
  const first = mk('text', { x: String(pad.l), y: String(H - 6), fill: '#8D938B', 'font-size': '11', 'font-family': 'JetBrains Mono, monospace' });
  first.textContent = new Date(data[0].t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const last = mk('text', { x: String(W - pad.r), y: String(H - 6), 'text-anchor': 'end', fill: '#8D938B', 'font-size': '11', 'font-family': 'JetBrains Mono, monospace' });
  last.textContent = new Date(data.at(-1)!.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  svg.append(first, last);
  wrap.append(svg);
  return wrap;
}
