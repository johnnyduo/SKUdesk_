// Builds the full audio track: per-scene voice segments placed on the timeline + a quiet synth music bed.
// Output: mix.wav (48 kHz stereo, exactly `total` seconds)
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DIR = import.meta.dirname;
const tmp = path.join(DIR, 'audio-seg');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const src = readFileSync(path.join(DIR, 'renderer-data.js'), 'utf8');
const total = Number(src.match(/"total":([\d.]+)/)[1]);
// renderer-data.js is `window.__DATA = {...};` — parse the JSON object directly:
const data = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));

const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });

// 1) per-scene segment: lead silence + voice + pad to exact scene duration
const segs = [];
for (const [i, sc] of data.scenes.entries()) {
  const n = String(i + 1).padStart(2, '0');
  const aiff = path.join(DIR, 'audio', `${n}-${sc.id}.aiff`);
  const out = path.join(tmp, `seg-${n}.wav`);
  const leadMs = Math.round(sc.caps[0].t0 * 1000);
  run(['-i', aiff, '-af', `aresample=48000,adelay=${leadMs}:all=1,apad`, '-t', String(sc.dur), '-ac', '1', '-ar', '48000', out]);
  segs.push(out);
}
// 2) concat voice
const list = path.join(tmp, 'list.txt');
writeFileSyncSafe(list, segs.map((s) => `file '${s}'`).join('\n') + '\n');
function writeFileSyncSafe(p, c) { execFileSync('node', ['-e', `require('fs').writeFileSync(process.argv[1], process.argv[2])`, p, c]); }
const voice = path.join(DIR, 'voice.wav');
run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', path.join(tmp, 'voice-raw.wav')]);
run(['-i', path.join(tmp, 'voice-raw.wav'), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000', '-ac', '1', voice]);

// 3) music bed: dark warm drone in A with a slow swell, fades in/out
const bedExpr = '0.050*sin(2*PI*55*t)+0.042*sin(2*PI*110.35*t)+0.034*sin(2*PI*164.6*t)+0.026*sin(2*PI*220.6*t)'
  + '+0.010*sin(2*PI*329.6*t)*(0.5+0.5*sin(2*PI*0.05*t+1.2))'
  + '+0.006*sin(2*PI*438.9*t)*(0.5+0.5*sin(2*PI*0.033*t))';
const bed = path.join(DIR, 'bed.wav');
run(['-f', 'lavfi', '-i', `aevalsrc=${bedExpr}:s=48000:d=${total}`, '-af',
  `lowpass=f=820,volume='min(1,0.25+0.75*sin(2*PI*0.021*t-1.4))':eval=frame,afade=t=in:d=3,afade=t=out:st=${(total - 4).toFixed(2)}:d=4,volume=0.30`,
  '-ac', '1', bed]);

// 4) mix
const mix = path.join(DIR, 'mix.wav');
run(['-i', voice, '-i', bed, '-filter_complex', '[0:a]aformat=channel_layouts=stereo[v];[1:a]aformat=channel_layouts=stereo,volume=0.5[b];[v][b]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.92,aresample=48000', mix]);

const dur = (() => {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mix]).toString().trim();
  return Number(out);
})();
console.log(`mix.wav ready: ${dur.toFixed(3)}s (timeline ${total}s)`);
