import { h, reduceMotion } from './client.ts';
import type { Device } from './devices.ts';

// A rotatable 3D model of one product. three.js and the scene are loaded lazily; without WebGL the flat illustration stays.
export interface Viewer { set(d: Device): void; dispose(): void; el: HTMLElement }

export function createViewer(initial: Device, accent = '#CCFF00'): Viewer {
  const art = h('img', { class: 'p3d-flat', src: initial.art, alt: '' });
  const stage = h('div', { class: 'p3d-stage' }, h('div', { class: 'p3d-art' }, art));
  const name = h('div', { class: 'p3d-name' }, initial.name);
  const sub = h('div', { class: 'p3d-compat' }, initial.sub ?? initial.category);
  const reset = h('button', { type: 'button', class: 'p3d-reset', 'aria-label': 'Reset view', hidden: true }, '↺');
  const hint = h('div', { class: 'p3d-hint', 'aria-hidden': 'true' }, 'drag to rotate');
  const top = h('div', { class: 'p3d-top' }, h('div', { class: 'p3d-id' }, h('span', { class: 'p3d-dot', 'aria-hidden': 'true' }), h('span', { class: 'p3d-sym mono' }, initial.symbol)), name, sub);
  const root = h('div', { class: 'p3d', role: 'group', 'aria-label': `${initial.name}: 3D product viewer`, 'data-model': initial.symbol }, h('div', { class: 'p3d-glow', 'aria-hidden': 'true' }), stage, top, reset, h('div', { class: 'p3d-bot' }, hint));
  root.style.setProperty('--acc', accent);

  let api: any = null, dead = false, current = initial, specs: any = null;
  const start = async (): Promise<void> => {
    try {
      const [T, sc, sp] = await Promise.all([import('three'), import('../showcase/product3d/scene'), import('../showcase/product3d/specs')]);
      if (dead) return;
      specs = sp;
      api = sc.createScene(T, stage, {
        reduced: reduceMotion(), padTop: () => top.offsetHeight + 6, padBottom: () => 36,
        onRotation: () => {}, onLost: () => stage.querySelector('.p3d-art')?.removeAttribute('hidden'), onRestored: () => {},
        onModified: (m: boolean) => { reset.hidden = !m; },
      });
      api.setProduct(sp.specForSymbol(current.symbol), accent);
      stage.querySelector('.p3d-art')?.remove();
      stage.querySelector('canvas')?.setAttribute('aria-label', `Rotatable 3D model of ${current.name}. Drag or use arrow keys to rotate, plus and minus to zoom, 0 to reset.`);
    } catch { /* no WebGL: the flat illustration stays */ }
  };
  reset.addEventListener('click', () => { api?.reset(); reset.hidden = true; });
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { io.disconnect(); void start(); } }, { rootMargin: '200px' });
    io.observe(root);
  } else void start();

  return {
    el: root,
    set(d) {
      current = d;
      art.src = d.art;
      name.textContent = d.name; sub.textContent = d.sub ?? d.category;
      root.setAttribute('aria-label', `${d.name}: 3D product viewer`); root.dataset.model = d.symbol;
      (root.querySelector('.p3d-sym') as HTMLElement).textContent = d.symbol;
      if (api && specs) api.setProduct(specs.specForSymbol(d.symbol), accent);
    },
    dispose() { dead = true; api?.dispose(); },
  };
}
