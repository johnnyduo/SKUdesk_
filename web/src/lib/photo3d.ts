import { h, reduceMotion } from './client.ts';

// A rotatable 3D cutout for a product that has no model of its own: the photo from the best offer with its background taken away,
// given some thickness and a soft shadow. Drag to turn it, scroll to zoom, arrow keys too. three.js loads lazily; without WebGL the flat photo stays.
export interface PhotoViewer { el: HTMLElement; src: string; dispose(): void }


/** Takes the plain backdrop away: flood fill from the edges over pixels close to the border colour, soften the cut, crop to the product. */
export function cutout(img: HTMLImageElement): HTMLCanvasElement | null {
  const scale = Math.min(2, 720 / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.max(8, Math.round(img.naturalWidth * scale)), H = Math.max(8, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, W, H);
  let data: ImageData;
  try { data = g.getImageData(0, 0, W, H); } catch { return null; }
  const px = data.data;
  // backdrop colour: the average of the border pixels
  let r = 0, gg = 0, b = 0, n = 0;
  const edge = (x: number, y: number): void => { const i = (y * W + x) * 4; r += px[i]; gg += px[i + 1]; b += px[i + 2]; n++; };
  for (let x = 0; x < W; x++) { edge(x, 0); edge(x, H - 1); }
  for (let y = 0; y < H; y++) { edge(0, y); edge(W - 1, y); }
  r /= n; gg /= n; b /= n;
  // Most product photos sit on white. If any real part of the border is white, treat white as the backdrop so a dark photo with thin white margins is still trimmed.
  let white = 0;
  const near = (x: number, y: number): void => { const i = (y * W + x) * 4; if (px[i] > 238 && px[i + 1] > 238 && px[i + 2] > 238) white++; };
  for (let x = 0; x < W; x++) { near(x, 0); near(x, H - 1); }
  for (let y = 0; y < H; y++) { near(0, y); near(W - 1, y); }
  if (white / n > 0.03) { r = gg = b = 255; }
  else {
    // no white to go by: only trim a backdrop that is one flat colour all round
    let spread = 0;
    const flat = (x: number, y: number): void => { const i = (y * W + x) * 4; spread += Math.hypot(px[i] - r, px[i + 1] - gg, px[i + 2] - b); };
    for (let x = 0; x < W; x++) { flat(x, 0); flat(x, H - 1); }
    for (let y = 0; y < H; y++) { flat(0, y); flat(W - 1, y); }
    if (spread / n > 14) return null;
  }
  const dist = (i: number): number => Math.hypot(px[i] - r, px[i + 1] - gg, px[i + 2] - b);
  const LOW = 22, HIGH = 60;
  const bg = new Uint8Array(W * H);
  const stack: number[] = [];
  const push = (x: number, y: number): void => { const k = y * W + x; if (!bg[k] && dist(k * 4) < HIGH * 0.55) { bg[k] = 1; stack.push(k); } };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const k = stack.pop()!, x = k % W, y = (k - x) / W;
    if (x > 0) push(x - 1, y); if (x < W - 1) push(x + 1, y); if (y > 0) push(x, y - 1); if (y < H - 1) push(x, y + 1);
  }
  let clear = 0, minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x, i = k * 4;
    if (bg[k]) { px[i + 3] = 0; clear++; continue; }
    // pixels that touch the cut fade in by how far they are from the backdrop colour, so the edge is soft and not white
    const touches = (x > 0 && bg[k - 1]) || (x < W - 1 && bg[k + 1]) || (y > 0 && bg[k - W]) || (y < H - 1 && bg[k + W]);
    if (touches) px[i + 3] = Math.round(255 * Math.min(1, Math.max(0.15, (dist(i) - LOW) / (HIGH - LOW))));
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const frac = clear / (W * H);
  if (frac < 0.004 || frac > 0.97 || maxX <= minX || maxY <= minY) return null; // no plain backdrop to remove, or nothing left
  g.putImageData(data, 0, 0);
  const pad = 3, cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad), cw = Math.min(W - cx, maxX - minX + 1 + pad * 2), ch = Math.min(H - cy, maxY - minY + 1 + pad * 2);
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d')!.drawImage(c, cx, cy, cw, ch, 0, 0, cw, ch);
  return out;
}

function shadowTexture(T: any): any {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,.55)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new T.CanvasTexture(c);
}

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

      const cut = cutout(img);
      const source: CanvasImageSource = cut ?? img;
      const sw = cut ? cut.width : img.naturalWidth, sh = cut ? cut.height : img.naturalHeight;
      const aspect = Math.max(0.4, Math.min(2.5, sw / Math.max(sh, 1)));
      const hgt = aspect > 1.3 ? 1.6 / aspect * 1.15 : 1.6;
      const wid = hgt * aspect;
      const tex = new T.Texture(source as any);
      tex.colorSpace = T.SRGBColorSpace;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      tex.needsUpdate = true;
      const plane = new T.PlaneGeometry(wid, hgt);
      const card = new T.Group();
      const thick = Math.min(wid, hgt) * 0.07;
      const LAYERS = 9;
      const mats: any[] = [];
      const faceMat = (color: number): any => { const m = new T.MeshStandardMaterial(cut ? { map: tex, alphaTest: 0.4, roughness: 0.5, metalness: 0.05, color } : { map: tex, roughness: 0.5, metalness: 0.05, color }); mats.push(m); return m; };
      // the sides: dark copies of the cutout stacked between the front and the back
      for (let i = 1; i < LAYERS - 1; i++) { const m = new T.Mesh(plane, faceMat(0x4a4d4a)); m.position.z = thick * (i / (LAYERS - 1) - 0.5); card.add(m); }
      const front = new T.Mesh(plane, faceMat(0xffffff)); front.position.z = thick / 2; card.add(front);
      const backM = new T.Mesh(plane, faceMat(0xdddddd)); backM.position.z = -thick / 2; backM.rotation.y = Math.PI; card.add(backM);
      scene.add(card);
      const shadow = new T.Mesh(new T.PlaneGeometry(wid * 1.5, wid * 0.5), new T.MeshBasicMaterial({ map: shadowTexture(T), transparent: true, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.position.y = -hgt / 2 - 0.12;
      scene.add(shadow);
      scene.add(new T.AmbientLight(0xffffff, 0.85));
      const key = new T.DirectionalLight(0xffffff, 1.3); key.position.set(2, 3, 4); scene.add(key);
      const rim = new T.DirectionalLight(new T.Color(accent), 1.4); rim.position.set(-3, 1, -2); scene.add(rim);

      let rx = -0.1, ry = 0.5, vx = 0, vy = 0, zoom = 1, drag = false, lx = 0, ly = 0, idle = 0, modified = false;
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
        shadow.scale.x = 1 - Math.abs(Math.sin(ry)) * 0.25;
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
      cleanup = (): void => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); tex.dispose(); plane.dispose(); mats.forEach((m) => m.dispose()); renderer.dispose(); };
    } catch { /* no WebGL or the photo could not be read: the flat photo stays */ }
  };
  void start();

  return { el: root, src, dispose() { dead = true; cleanup(); } };
}
