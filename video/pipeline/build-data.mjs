// Builds renderer-data.js (timeline for the HTML renderer) and subs.srt from scenes.json + real audio durations.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIR = import.meta.dirname;
const conf = JSON.parse(readFileSync(path.join(DIR, 'scenes.json'), 'utf8'));
const still = (n) => `stills/${n}.png`;

// scene -> still and Ken Burns motion (fx/fy in [-1,1]; s = scale)
const kb = (s0, x0, y0, s1, x1, y1) => ({ from: { s: s0, fx: x0, fy: y0 }, to: { s: s1, fx: x1, fy: y1 } });
const DESIGN = {
  'hook-a': { image: still('01-hero'), motion: kb(1.0, 0.0, 0.0, 1.12, -0.35, 0.0) },
  'hook-b': { image: still('02-stats'), motion: kb(1.08, 0.0, 0.1, 1.0, 0.0, 0.0) },
  's1-a': { image: still('03-run'), motion: kb(1.0, 0.0, 0.0, 1.10, 0.0, 0.15) },
  's1-b': { image: still('04-verdict'), motion: kb(1.06, -0.2, 0.0, 1.0, 0.0, 0.0) },
  's1-c': { image: still('05-ladder'), motion: kb(1.0, 0.0, 0.0, 1.10, 0.15, 0.2) },
  's2-a': { image: still('06-approval'), motion: kb(1.10, 0.0, 0.1, 1.0, 0.0, 0.0) },
  's2-b': { image: still('07-titanic'), motion: kb(1.0, 0.0, -0.2, 1.08, 0.0, 0.2) },
  's3-a': { image: still('08-show'), motion: kb(1.0, 0.0, 0.0, 1.10, -0.2, 0.1) },
  's4-a': { image: still('09-market'), motion: kb(1.08, 0.2, 0.0, 1.0, 0.0, 0.0) },
  's5-a': { image: still('10-deck-evidence'), motion: kb(1.0, 0.0, 0.0, 1.08, 0.0, 0.0) },
  's5-b': { image: still('11-deck-zero'), motion: kb(1.08, 0.0, 0.0, 1.0, 0.0, 0.0) },
  's6-a': { image: still('12-owner'), motion: kb(1.0, 0.0, 0.0, 1.09, 0.0, 0.2) },
  's6-b': { image: still('13-limits'), motion: kb(1.08, 0.0, 0.1, 1.0, 0.0, 0.0) },
  's7-a': { image: still('14-deploy'), motion: kb(1.0, 0.0, 0.0, 1.08, 0.0, 0.2) },
  outro: { kind: 'outro' },
};

const LEAD = 0.30, TAIL = 0.45, XFADE = 0.5;
const audioDur = (i, id) => {
  const f = path.join(DIR, 'audio', `${String(i + 1).padStart(2, '0')}-${id}.aiff`);
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]).toString().trim());
};

let t = 0;
const scenes = conf.scenes.map((sc, i) => {
  const a = audioDur(i, sc.id);
  const lead = i === 0 ? 0.7 : LEAD;
  const tail = sc.id === 'outro' ? 2.6 : TAIL;
  const dur = Number((lead + a + tail).toFixed(3));
  const design = DESIGN[sc.id];
  if (!design) throw new Error(`no design for ${sc.id}`);
  if (design.image && !existsSync(path.join(DIR, design.image))) throw new Error(`missing still ${design.image} for ${sc.id}`);
  const w = sc.caps.map((c) => c.length);
  const W = w.reduce((x, y) => x + y, 0);
  let acc = 0;
  const caps = sc.caps.map((c, k) => {
    const s = lead + (acc / W) * a;
    acc += w[k];
    return { text: c, t0: Number(s.toFixed(3)), t1: Number((lead + (acc / W) * a).toFixed(3)) };
  });
  const scene = { id: sc.id, num: i + 1, chapter: sc.chapter, title: sc.title, kind: design.kind ?? 'full', image: design.image ?? null, motion: design.motion ?? null, start: Number(t.toFixed(3)), dur, caps };
  t += dur;
  return scene;
});
const total = Number(t.toFixed(3));
writeFileSync(path.join(DIR, 'renderer-data.js'), `window.__DATA = ${JSON.stringify({ fps: 30, width: 1920, height: 1080, total, xfade: XFADE, scenes })};\n`);

const fmt = (x) => {
  const h = String(Math.floor(x / 3600)).padStart(2, '0');
  const m = String(Math.floor((x % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(x % 60)).padStart(2, '0');
  const ms = String(Math.round((x - Math.floor(x)) * 1000)).padStart(3, '0');
  return `${h}:${m}:${s},${ms}`;
};
let n = 0, srt = '';
for (const sc of scenes) for (const c of sc.caps) srt += `${++n}\n${fmt(sc.start + c.t0)} --> ${fmt(sc.start + c.t1 + 0.25)}\n${c.text}\n\n`;
writeFileSync(path.join(DIR, 'subs.srt'), srt);
console.log(`total ${total}s (${(total / 60).toFixed(2)} min), ${scenes.length} scenes`);
