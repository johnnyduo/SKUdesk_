import { h, reduceMotion } from './client.ts';

// A rotatable 3D card for a product that has no model of its own: the photo from the best offer on a thin slab, front and back.
// Drag to turn it, scroll or pinch to zoom, arrow keys too. three.js loads lazily; without WebGL the flat photo stays.
export interface PhotoViewer { el: HTMLElement; src: string; dispose(): void }

export function createPhotoViewer(src: string, symbol: string, name: string, sub: string, accent = '#CCFF00'): PhotoViewer {
  const flat = h('img', { class: 'p3d-flat', src, alt: '' });
  const stage = h('div', { class: 'p3d-stage' }, h('div', { class: 'p3d-art' }, flat));
  const reset = h('button', { type: 'button', class: 'p3d-reset', 'aria-label': 'Reset view', hidden: true }, '↺');
  const hint = h('div', { class: 'p3d-hint', 'aria-hidden': 'true' }, 'drag to rotate · photo from the best offer');
  const top = h('div', { class: 'p3d-top' }, h('div', { class: 'p3d-id' }, h('span', { class: 'p3d-dot', 'aria-hidden': 'true' }), h('span', { class: 'p3d-sym mono' }, symbol)), h('div', { class: 'p3d-name' }, name), h('div', { class: 'p3d-compat' }, sub));
  const root = h('div', { class: 'p3d p3d-photo3d', role: 'group', 'aria-label': `${name}: 3D product viewer`, 'data-model': symbol }, h('div', { class: 'p3d-glow', 'aria-hidden': 'true' }), stage, top, h('div', { class: 'p3d-bot' }, hint, reset));
  root.style.setProperty('--acc', accent);

  let dead = false;
  let cleanup = (): void => {};

  const start = async (): Promise<void> => {
    try {
      const T = await import('three');
      if (dead) return;
      const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
      if (dead) return;
      const canvas = h('canvas', { class: 'p3d-canvas', tabindex: 0, role: 'img', 'aria-label': `Rotatable 3D card of ${name}. Drag or use the arrow keys to rotate, plus and minus to zoom, 0 to reset.` }) as HTMLCanvasElement;
      const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      renderer.outputColorSpace = T.SRGBColorSpace;
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(32, 1, 0.1, 50);

      const aspect = Math.max(0.5, Math.min(2, img.naturalWidth / Math.max(img.naturalHeight, 1)));
      const hgt = aspect > 1.2 ? 1.6 / aspect : 1.6;
      const wid = hgt * aspect;
      const tex = new T.Texture(img);
      tex.colorSpace = T.SRGBColorSpace;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      tex.needsUpdate = true;
      const face = new T.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.02 });
      const edge = new T.MeshStandardMaterial({ color: 0x1b1e1c, roughness: 0.4, metalness: 0.5 });
      const card = new T.Mesh(new T.BoxGeometry(wid, hgt, 0.07), [edge, edge, edge, edge, face, face]);
      // the back face is mirrored by the box, so flip its texture the other way round
      const back = tex.clone(); back.wrapS = T.RepeatWrapping; back.repeat.x = -1; back.offset.x = 1; back.needsUpdate = true;
      (card.material as any)[5] = new T.MeshStandardMaterial({ map: back, roughness: 0.55, metalness: 0.02 });
      scene.add(card);
      scene.add(new T.AmbientLight(0xffffff, 1.1));
      const key = new T.DirectionalLight(0xffffff, 2.2); key.position.set(2, 3, 4); scene.add(key);
      const rim = new T.DirectionalLight(new T.Color(accent), 1.4); rim.position.set(-3, 1, -2); scene.add(rim);

      let rx = -0.08, ry = 0.5, vx = 0, vy = 0, zoom = 1, drag = false, lx = 0, ly = 0, idle = 0, modified = false;
      const reduced = reduceMotion();
      const frame = (): void => {
        const W = stage.clientWidth || 300, H = stage.clientHeight || 300;
        if (canvas.width !== Math.round(W * renderer.getPixelRatio()) || canvas.height !== Math.round(H * renderer.getPixelRatio())) renderer.setSize(W, H, false);
        camera.aspect = W / H; camera.updateProjectionMatrix();
        const dist = (Math.max(hgt, wid / camera.aspect) * 0.62) / Math.tan((camera.fov * Math.PI) / 360) / zoom + 0.2;
        camera.position.set(0, 0, dist);
        if (!drag) {
          ry += vy; rx += vx; vy *= 0.94; vx *= 0.94;
          if (!reduced && !modified) { idle += 0.012; ry = 0.5 * Math.sin(idle); rx = -0.08 + 0.05 * Math.sin(idle * 0.7); }
        }
        rx = Math.max(-0.9, Math.min(0.9, rx));
        card.rotation.set(rx, ry, 0);
        renderer.render(scene, camera);
      };
      let raf = 0;
      const loop = (): void => { frame(); raf = requestAnimationFrame(loop); };
      const touch = (): void => { modified = true; reset.hidden = false; };
      canvas.addEventListener('pointerdown', (e) => { drag = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); canvas.classList.add('grab'); touch(); });
      canvas.addEventListener('pointermove', (e) => { if (!drag) return; vy = (e.clientX - lx) * 0.01; vx = (e.clientY - ly) * 0.008; ry += vy; rx += vx; lx = e.clientX; ly = e.clientY; });
      const up = (): void => { drag = false; canvas.classList.remove('grab'); };
      canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
      canvas.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 1) return; e.preventDefault(); zoom = Math.max(0.7, Math.min(2.4, zoom * (e.deltaY < 0 ? 1.08 : 0.93))); touch(); }, { passive: false });
      canvas.addEventListener('keydown', (e) => {
        const k = e.key;
        if (k === 'ArrowLeft') vy = -0.05; else if (k === 'ArrowRight') vy = 0.05; else if (k === 'ArrowUp') vx = -0.04; else if (k === 'ArrowDown') vx = 0.04;
        else if (k === '+' || k === '=') zoom = Math.min(2.4, zoom * 1.12); else if (k === '-') zoom = Math.max(0.7, zoom / 1.12);
        else if (k === '0') { rx = -0.08; ry = 0.5; zoom = 1; vx = vy = 0; modified = false; reset.hidden = true; return; } else return;
        touch(); e.preventDefault();
      });
      reset.addEventListener('click', () => { rx = -0.08; ry = 0.5; zoom = 1; vx = vy = 0; modified = false; reset.hidden = true; });
      const onVis = (): void => { cancelAnimationFrame(raf); if (!document.hidden && !dead) loop(); };
      document.addEventListener('visibilitychange', onVis);

      stage.querySelector('.p3d-art')?.remove();
      stage.append(canvas);
      loop();
      cleanup = (): void => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); tex.dispose(); back.dispose(); renderer.dispose(); };
    } catch { /* no WebGL or the photo could not be read: the flat photo stays */ }
  };
  void start();

  return { el: root, src, dispose() { dead = true; cleanup(); } };
}
