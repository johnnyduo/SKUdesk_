import { AbsoluteFill, Audio, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import timing from './timing.json';

const NEON = '#ccff00';
const W = 1440; const H = 900;
const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const LABELS: Record<string, string> = { why: 'The problem', run: 'A live check', verdict: 'The answer', pixel: 'An honest no', market: 'The market view', switch: 'Every product', orders: 'A person decides', listings: 'Merchant Center', eval: 'Measured, not claimed' };
const segs = timing.segs; const rects = timing.rects;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const ease = (x: number) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
const sentences = (t: string): string[] => t.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [t];

// ── the camera: eases in on each measured target, holds, eases back out ──
type Cam = { s: number; tx: number; ty: number; rect?: typeof rects[number]; p: number };
const camAt = (t: number): Cam => {
  const IN = 0.7, HOLD = 2.6, OUT = 0.8;
  for (const r of rects) {
    const a = r.t - 0.1; const b = a + IN + HOLD + OUT;
    if (t < a || t > b) continue;
    const p = t < a + IN ? ease((t - a) / IN) : t > a + IN + HOLD ? 1 - ease((t - a - IN - HOLD) / OUT) : 1;
    const s = clamp(Math.min((W * 0.6) / r.w, (H * 0.6) / r.h), 1.18, 1.75);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const tx = clamp(W / 2 - cx * s, W - W * s, 0), ty = clamp(H / 2 - cy * s, H - H * s, 0);
    return { s: 1 + (s - 1) * p, tx: tx * p, ty: ty * p, rect: r, p };
  }
  return { s: 1, tx: 0, ty: 0, p: 0 };
};

const Net: React.FC<{ glow?: number }> = ({ glow = 1 }) => {
  const f = useCurrentFrame();
  const cols = 9, rows = 5;
  const pts = Array.from({ length: cols * rows }, (_, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const j = (n: number) => ((Math.sin((i + 1) * 12.9898 + n) * 43758.5453) % 1 + 1) % 1;
    return { x: 80 + c * ((W - 160) / (cols - 1)) + Math.sin(f / 40 + i) * 14 + (j(1) - 0.5) * 40, y: 160 + r * 150 + Math.cos(f / 47 + i * 1.7) * 14 + (j(2) - 0.5) * 40, i, c };
  });
  const links: [number, number][] = [];
  pts.forEach((p, i) => { if (p.c < cols - 1) { links.push([i, i + 1]); if ((i * 7) % 3 === 0 && i + cols + 1 < pts.length) links.push([i, i + cols + 1]); } if (i + cols < pts.length && (i * 5) % 4 === 0) links.push([i, i + cols]); });
  return (
    <svg width={W} height={H} style={{ position: 'absolute', inset: 0, opacity: 0.55 * glow }}>
      {links.map(([a, b], k) => {
        const A = pts[a]!, B = pts[b]!; const ph = ((f / 60 + k * 0.173) % 1);
        return (<g key={k}><line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke="rgba(204,255,0,.14)" /><circle cx={A.x + (B.x - A.x) * ph} cy={A.y + (B.y - A.y) * ph} r={2.4} fill={NEON} opacity={0.9} /></g>);
      })}
      {pts.map((p) => (<circle key={p.i} cx={p.x} cy={p.y} r={3 + Math.sin(f / 18 + p.i) * 1.2} fill={p.c < 4 ? '#8a93a3' : NEON} opacity={0.75} />))}
    </svg>
  );
};

const Intro: React.FC = () => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const a = (d: number) => spring({ frame: f - d, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 45%, #10140a 0%, #000 70%)', color: '#fff', fontFamily: FONT, alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <Net />
      <div style={{ position: 'relative' }}>
        <div style={{ fontSize: 132, fontWeight: 700, letterSpacing: -4, opacity: a(4), transform: `translateY(${(1 - a(4)) * 36}px) scale(${0.96 + a(4) * 0.04})`, textShadow: `0 0 60px ${NEON}33` }}>SKUdesk</div>
        <div style={{ fontSize: 38, color: NEON, marginTop: 14, opacity: a(16), transform: `translateY(${(1 - a(16)) * 22}px)` }}>One price you can trust, only for the same item.</div>
        <div style={{ width: 180 * a(30), height: 2, background: NEON, margin: '36px auto 0' }} />
        <div style={{ fontSize: 24, color: '#b4bcc9', marginTop: 28, opacity: a(34) }}>Chonlarnatt Poonchattakarn · Ploypitcha Boontavipitak</div>
        <div style={{ fontSize: 20, color: '#6b7380', marginTop: 12, opacity: a(42) }}>Google Cloud AI Builder Cup 2026 · Retail & Commerce</div>
      </div>
    </AbsoluteFill>
  );
};

const Outro: React.FC = () => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const a = (d: number) => spring({ frame: f - d, fps, config: { damping: 200 } });
  const items = ['Cloud Run', 'Firestore', 'Cloud Scheduler', 'Secret Manager', 'Gemini', 'Merchant API'];
  return (
    <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 45%, #10140a 0%, #000 70%)', color: '#fff', fontFamily: FONT, alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
      <Net />
      <div style={{ position: 'relative' }}>
        <div style={{ fontSize: 120, fontWeight: 700, letterSpacing: -3, opacity: a(0), transform: `scale(${0.92 + a(0) * 0.08})`, textShadow: `0 0 60px ${NEON}33` }}>skudesk.lol</div>
        <div style={{ display: 'flex', gap: 14, marginTop: 40, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 1100 }}>
          {items.map((s, i) => (<div key={s} style={{ fontSize: 25, padding: '10px 22px', border: `1px solid ${NEON}`, color: NEON, borderRadius: 999, background: 'rgba(0,0,0,.5)', opacity: a(8 + i * 4), transform: `translateY(${(1 - a(8 + i * 4)) * 18}px)` }}>{s}</div>))}
        </div>
        <div style={{ fontSize: 24, color: '#b4bcc9', marginTop: 52, opacity: a(44) }}>github.com/johnnyduo/SKUdesk_</div>
      </div>
    </AbsoluteFill>
  );
};

const Caption: React.FC<{ text: string; dur: number }> = ({ text, dur }) => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const parts = sentences(text); const total = parts.reduce((n, s) => n + s.length, 0);
  const t = f / fps; let acc = 0; let idx = parts.length - 1; let before = 0;
  for (let i = 0; i < parts.length; i++) { const l = parts[i]!.length / total * dur; if (t <= acc + l) { idx = i; before = acc; break; } acc += l; before = acc; }
  const len = parts[idx]!.length / total * dur; const local = t - before;
  const op = interpolate(local, [0, 0.2, len - 0.2, len], [0, 1, 1, 0.92], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', left: 90, right: 90, bottom: 34, display: 'flex', justifyContent: 'center', opacity: op, transform: `translateY(${(1 - clamp(local / 0.25, 0, 1)) * 8}px)` }}>
      <div style={{ background: 'rgba(6,8,4,.82)', color: '#fff', fontFamily: FONT, fontSize: 28, lineHeight: 1.35, padding: '14px 28px', borderRadius: 14, border: '1px solid rgba(204,255,0,.28)', textAlign: 'center', maxWidth: 1200, boxShadow: '0 10px 40px rgba(0,0,0,.5)' }}>{parts[idx]}</div>
    </div>
  );
};

const Tag: React.FC<{ label: string; n: number }> = ({ label, n }) => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 18, stiffness: 120 } });
  const out = interpolate(f, [110, 130], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', top: 64, right: 24, display: 'flex', alignItems: 'center', gap: 12, transform: `translateX(${(1 - s) * 80}px)`, opacity: s * out, fontFamily: FONT }}>
      <div style={{ background: 'rgba(6,8,4,.88)', color: '#fff', fontSize: 24, fontWeight: 600, padding: '9px 20px 9px 14px', borderRadius: 12, border: `1px solid ${NEON}66`, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 32, height: 32, borderRadius: '50%', background: NEON, color: '#000', fontWeight: 700, fontSize: 18, display: 'grid', placeItems: 'center' }}>{n}</span>{label}
      </div>
    </div>
  );
};

// a bright sweep between scenes
const Wipe: React.FC = () => {
  const f = useCurrentFrame();
  const x = interpolate(f, [0, 14], [-200, W + 200], { extrapolateRight: 'clamp' });
  if (f > 15) return null;
  return (<AbsoluteFill style={{ pointerEvents: 'none' }}>
    <div style={{ position: 'absolute', top: 0, bottom: 0, left: x, width: 160, background: `linear-gradient(90deg, transparent, ${NEON}55, transparent)`, filter: 'blur(6px)' }} />
    <AbsoluteFill style={{ background: '#000', opacity: interpolate(f, [0, 5, 14], [0, 0.35, 0], { extrapolateRight: 'clamp' }) }} />
  </AbsoluteFill>);
};

export const Demo: React.FC = () => {
  const f = useCurrentFrame(); const { fps, durationInFrames } = useVideoConfig();
  const t = f / fps; const cam = camAt(t);
  const first = segs[0]!, last = segs[segs.length - 1]!;
  const r = cam.rect; const pulse = 0.5 + 0.5 * Math.sin(f / 5);
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <AbsoluteFill style={{ transform: `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.s})`, transformOrigin: '0 0' }}>
        <OffthreadVideo src={staticFile('demo.mp4')} muted />
        {r && cam.p > 0.02 && (
          <div style={{ position: 'absolute', left: r.x - 6, top: r.y - 6, width: r.w + 12, height: r.h + 12, border: `${2 / cam.s * 1.4}px solid ${NEON}`, borderRadius: 10 / cam.s, boxShadow: `0 0 ${18 + pulse * 14}px ${NEON}66, inset 0 0 ${14 / cam.s}px ${NEON}22`, opacity: cam.p, pointerEvents: 'none' }}>
            <div style={{ position: 'absolute', left: 0, top: r.y > 52 ? -44 / cam.s : r.h + 10, transformOrigin: '0 0', transform: `scale(${1 / cam.s})`, whiteSpace: 'nowrap', background: NEON, color: '#000', fontFamily: FONT, fontWeight: 700, fontSize: 21, padding: '6px 14px', borderRadius: 8 }}>{r.label}</div>
          </div>
        )}
      </AbsoluteFill>
      <Audio src={staticFile('demo.mp4')} />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at 50% 50%, transparent 62%, rgba(0,0,0,.45) 100%)', pointerEvents: 'none' }} />
      <Sequence from={0} durationInFrames={Math.round(segs[1]!.start * fps)}><Intro /></Sequence>
      <Sequence from={Math.round(last.start * fps)}><Outro /></Sequence>
      {segs.map((s, i) => {
        const from = Math.round(s.start * fps); const to = Math.round((segs[i + 1]?.start ?? timing.total) * fps);
        return (
          <Sequence key={s.id} from={from} durationInFrames={to - from}>
            {i > 0 && i < segs.length - 1 && <Tag label={LABELS[s.id] ?? s.id} n={i} />}
            <Caption text={s.text} dur={s.dur} />
          </Sequence>
        );
      })}
      {segs.slice(1).map((s) => (<Sequence key={`w-${s.id}`} from={Math.round(s.start * fps) - 2} durationInFrames={16}><Wipe /></Sequence>))}
      <div style={{ position: 'absolute', top: 0, left: 0, height: 4, width: `${(f / durationInFrames) * 100}%`, background: NEON, boxShadow: `0 0 12px ${NEON}` }} />
      <AbsoluteFill style={{ background: '#000', opacity: interpolate(f, [durationInFrames - 20, durationInFrames - 1], [0, 1], { extrapolateLeft: 'clamp' }), pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};
