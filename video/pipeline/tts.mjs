// Speaks every scene with macOS `say` into audio/NN-id.aiff.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = import.meta.dirname;
const conf = JSON.parse(readFileSync(path.join(DIR, 'scenes.json'), 'utf8'));
mkdirSync(path.join(DIR, 'audio'), { recursive: true });
conf.scenes.forEach((s, i) => {
  const n = String(i + 1).padStart(2, '0');
  execFileSync('say', ['-v', conf.voice, '-r', String(conf.rate), '-o', path.join(DIR, 'audio', `${n}-${s.id}.aiff`), s.text]);
});
console.log(`spoke ${conf.scenes.length} scenes`);
