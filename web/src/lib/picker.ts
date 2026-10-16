import { fill, h } from './client.ts';

// A select-only combobox for choosing the product: one tap from anywhere on the page, grouped, with each row's
// last price and change. Focus stays on the button; the arrow keys move the highlight (aria-activedescendant).

export interface PickItem { id: string; symbol: string; name: string; sub: string; price: string; change: string; dir: string; group: string; spark?: string }
export interface Picker { el: HTMLElement; set(items: PickItem[], selected: string): void }

const ns = 'http://www.w3.org/2000/svg';
function sparkEl(points: string | undefined, dir: string): SVGElement | HTMLElement {
  if (!points) return h('span', { class: 'mk-spark-blank', 'aria-hidden': 'true' });
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 52 20'); svg.setAttribute('width', '52'); svg.setAttribute('height', '20'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `mk-spark mk-spark-${dir}`);
  const pl = document.createElementNS(ns, 'polyline');
  pl.setAttribute('fill', 'none'); pl.setAttribute('stroke-width', '1.4'); pl.setAttribute('points', points);
  svg.append(pl);
  return svg;
}

export function createPicker(onPick: (id: string) => void): Picker {
  let items: PickItem[] = [];
  let selected = '';
  let active = 0;
  let open = false;
  const uid = `pk${Math.random().toString(36).slice(2, 7)}`;
  const btn = h('button', { type: 'button', class: 'mk-pk-btn', role: 'combobox', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': `${uid}-l`, 'aria-label': 'Product', 'data-testid': 'product-picker' });
  const list = h('div', { class: 'mk-pk-list', role: 'listbox', id: `${uid}-l`, 'aria-label': 'Products', hidden: true });
  const el = h('div', { class: 'mk-pk' }, btn, list);

  const optId = (i: number): string => `${uid}-o${i}`;
  const paintBtn = (): void => {
    const it = items.find((x) => x.id === selected);
    fill(btn,
      h('span', { class: 'mk-pk-id' }, h('b', { class: 'mk-pk-sym' }, it?.symbol ?? 'Choose a product'), h('span', { class: 'mk-pk-name' }, it?.name ?? '')),
      it ? h('span', { class: 'mk-pk-px' }, h('span', { class: 'n' }, it.price), h('span', { class: `n mk-pk-ch ${it.dir}` }, it.change)) : null,
      h('span', { class: 'mk-pk-caret', 'aria-hidden': 'true' }, '▾'));
  };
  const paintList = (): void => {
    const groups = [...new Set(items.map((i) => i.group))];
    const nodes: HTMLElement[] = [];
    groups.forEach((g, gi) => {
      nodes.push(h('div', { class: 'mk-pk-g', role: 'presentation', id: `${uid}-g${gi}` }, g));
      items.forEach((it, i) => {
        if (it.group !== g) return;
        nodes.push(h('div', { class: `mk-pk-o${it.id === selected ? ' sel' : ''}${i === active ? ' act' : ''}`, role: 'option', id: optId(i), 'aria-selected': String(it.id === selected), 'data-id': it.id, 'data-symbol': it.symbol, on: { click: () => choose(i), pointermove: () => { if (active !== i) { active = i; markActive(); } } } },
          h('span', { class: 'mk-pk-id' }, h('b', { class: 'mk-pk-sym' }, it.symbol), h('span', { class: 'mk-pk-name' }, it.name), h('span', { class: 'mk-pk-sub' }, it.sub)),
          sparkEl(it.spark, it.dir),
          h('span', { class: 'mk-pk-px' }, h('span', { class: 'n' }, it.price), h('span', { class: `n mk-pk-ch ${it.dir}` }, it.change))));
      });
    });
    list.replaceChildren(...nodes);
  };
  const markActive = (): void => {
    list.querySelectorAll('.mk-pk-o').forEach((o) => o.classList.toggle('act', o.id === optId(active)));
    btn.setAttribute('aria-activedescendant', open ? optId(active) : '');
    document.getElementById(optId(active))?.scrollIntoView({ block: 'nearest' });
  };
  const setOpen = (v: boolean): void => {
    open = v;
    list.hidden = !v;
    btn.setAttribute('aria-expanded', String(v));
    if (v) { active = Math.max(0, items.findIndex((x) => x.id === selected)); paintList(); markActive(); } else btn.removeAttribute('aria-activedescendant');
  };
  function choose(i: number): void {
    const it = items[i];
    setOpen(false);
    btn.focus();
    if (it && it.id !== selected) onPick(it.id);
  }
  btn.addEventListener('click', () => setOpen(!open));
  btn.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { setOpen(true); e.preventDefault(); return; }
    if (!open) return;
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); markActive(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); markActive(); e.preventDefault(); }
    else if (e.key === 'Home') { active = 0; markActive(); e.preventDefault(); }
    else if (e.key === 'End') { active = items.length - 1; markActive(); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { choose(active); e.preventDefault(); }
    else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
    else if (e.key.length === 1) {
      const q = e.key.toLowerCase();
      const from = (active + 1) % items.length;
      const hit = [...items.slice(from), ...items.slice(0, from)].find((x) => x.name.toLowerCase().startsWith(q) || x.symbol.toLowerCase().startsWith(q));
      if (hit) { active = items.indexOf(hit); markActive(); }
    }
  });
  document.addEventListener('pointerdown', (e) => { if (open && !el.contains(e.target as Node)) setOpen(false); }, true);

  return {
    el,
    set(next, sel) {
      items = next; selected = sel;
      paintBtn();
      if (open) { paintList(); markActive(); }
    },
  };
}
