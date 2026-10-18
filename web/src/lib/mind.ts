// A small live graph of the agent working: one column of nodes per stage, signals travelling along the links.
// It only moves while a check runs. The active column glows, and every verdict from Gemini sends a pulse through
// the graph in that verdict's colour, so the motion follows real events and is not decoration on a timer.

interface Node { x: number; y: number; layer: number; glow: number }
interface Signal { a: Node; b: Node; t: number; speed: number; color: string }

const COLORS = { idle: '#8a93a3', act: '#ccff00', identical: '#3ed598', different: '#ff7a7a', uncertain: '#ffb224' } as const;
export type Tone = keyof typeof COLORS;

export interface Mind { el: HTMLCanvasElement; setLayer(i: number): void; pulse(tone: Tone): void; run(): void; stop(): void }

export function createMind(layers = 6, perLayer = 5): Mind {
  const el = document.createElement('canvas');
  el.className = 'mind';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'Live graph of the agent working through its stages');
  const ctx = el.getContext('2d');
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nodes: Node[] = [];
  const links: [Node, Node][] = [];
  const signals: Signal[] = [];
  let active = 0;
  let raf = 0;
  let w = 0;
  let h = 0;

  // Fixed pseudo-random offsets so the shape is the same on every render.
  const jitter = (i: number): number => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
  const layout = (): void => {
    const r = el.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(240, Math.round(r.width));
    h = Math.max(70, Math.round(r.height));
    el.width = w * dpr; el.height = h * dpr;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    nodes.length = 0; links.length = 0;
    for (let l = 0; l < layers; l++) {
      for (let k = 0; k < perLayer; k++) {
        const j = jitter(l * 7 + k);
        nodes.push({ layer: l, glow: 0, x: 18 + (w - 36) * (l / (layers - 1)) + (j - 0.5) * 10, y: 10 + (h - 20) * ((k + 0.5) / perLayer) + (jitter(l * 3 + k * 5) - 0.5) * 8 });
      }
    }
    const at = (l: number): Node[] => nodes.filter((n) => n.layer === l);
    for (let l = 0; l < layers - 1; l++) for (const a of at(l)) for (const b of at(l + 1)) if (jitter(nodes.indexOf(a) * 31 + nodes.indexOf(b)) < 0.55) links.push([a, b]);
  };

  const spawn = (color: string, count = 1): void => {
    for (let i = 0; i < count && signals.length < 60; i++) {
      const pool = links.filter(([a]) => a.layer === Math.max(0, active - 1) || a.layer === active);
      const [a, b] = pool[Math.floor(Math.random() * pool.length)] ?? links[0] ?? [nodes[0], nodes[1]];
      if (a && b) signals.push({ a, b, t: 0, speed: 0.012 + Math.random() * 0.014, color });
    }
  };

  const draw = (): void => {
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    for (const [a, b] of links) {
      const hot = a.layer === active || a.layer === active - 1;
      ctx.strokeStyle = hot ? 'rgba(204,255,0,.22)' : 'rgba(138,147,163,.16)';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (const n of nodes) {
      n.glow = Math.max(0, n.glow - 0.02);
      const on = n.layer === active;
      const base = n.layer < active ? COLORS.identical : on ? COLORS.act : COLORS.idle;
      const wobble = on && !reduce ? 0.5 + 0.5 * Math.sin(performance.now() / 260 + n.x) : 0;
      ctx.globalAlpha = n.layer > active ? 0.35 : 0.9;
      ctx.fillStyle = base;
      ctx.beginPath(); ctx.arc(n.x, n.y, 2.2 + wobble * 1.4 + n.glow * 2.5, 0, Math.PI * 2); ctx.fill();
      if (on || n.glow > 0) { ctx.globalAlpha = 0.18 + n.glow * 0.3; ctx.beginPath(); ctx.arc(n.x, n.y, 6 + wobble * 3 + n.glow * 6, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    for (let i = signals.length - 1; i >= 0; i--) {
      const s = signals[i]!;
      s.t += s.speed;
      if (s.t >= 1) { s.b.glow = 1; signals.splice(i, 1); continue; }
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(s.a.x + (s.b.x - s.a.x) * s.t, s.a.y + (s.b.y - s.a.y) * s.t, 2.4, 0, Math.PI * 2); ctx.fill();
    }
  };

  const frame = (): void => {
    if (!el.isConnected) { raf = 0; return; }
    if (Math.random() < 0.18) spawn(COLORS.act);
    draw();
    raf = requestAnimationFrame(frame);
  };

  return {
    el,
    setLayer(i) { active = Math.max(0, Math.min(layers - 1, i)); spawn(COLORS.act, 4); if (!raf) { layout(); draw(); } },
    pulse(tone) { spawn(COLORS[tone], 3); },
    run() {
      layout();
      if (reduce) { draw(); return; }
      if (!raf) raf = requestAnimationFrame(frame);
    },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; active = layers - 1; signals.length = 0; layout(); draw(); },
  };
}
