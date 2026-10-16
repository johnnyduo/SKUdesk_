import { h, thumbSrc } from './client.ts';

const STAGES: [string, string][] = [['search', 'Search listings'], ['gate', 'Identity gate'], ['photos', 'Photo check'], ['sanity', 'Price sanity'], ['economics', 'Economics'], ['briefing', 'Briefing']];

// A live progress panel for one check: six stages and a wall of listings that light up as Gemini judges each one.
export function createRunPanel(): { el: HTMLElement; handle(ev: any): void; start(): void; finish(): void } {
  const steps = STAGES.map(([key, label], i) => h('li', { class: 'stage-step', 'data-s': key }, h('b', {}, i + 1), label));
  const msg = h('p', { class: 'run-msg' }, 'Starting…');
  const wall = h('div', { class: 'wall', 'aria-label': 'Listings being judged' });
  const el = h('div', { class: 'run card', 'aria-live': 'polite' }, h('ol', { class: 'stages' }, steps), msg, wall);
  const setStage = (name: string, all = false): void => {
    const at = STAGES.findIndex(([k]) => k === name);
    steps.forEach((s, i) => { s.classList.toggle('done', all || i < at); s.classList.toggle('act', !all && i === at); });
  };
  return {
    el,
    start() { wall.replaceChildren(); setStage('search'); msg.textContent = 'Searching Google Shopping…'; },
    finish() { setStage('briefing', true); },
    handle(ev) {
      if (ev.type === 'search') { setStage('gate'); msg.textContent = `Found ${ev.listings} listings${ev.fromCache ? ' (cached search)' : ''}. Asking Gemini whether each one is the identical product…`; }
      else if (ev.type === 'gate') {
        const src = thumbSrc(ev.thumbnail);
        wall.append(h('div', { class: `chip ${ev.verdict}`, title: `${ev.seller}: ${ev.title}` }, src ? h('img', { src, alt: '' }) : null, h('i')));
        msg.textContent = `Judged ${ev.done} of ${ev.total}. Green passes, red is a different product, amber is not provable.`;
      } else if (ev.type === 'vision') {
        setStage('photos');
        msg.textContent = `Looking at the photos: ${ev.done} of ${ev.total}. ${ev.seller}: ${ev.seen ? ev.seen : 'no clear view'}${ev.verdict === 'different' ? ' (not the product, dropped)' : ''}`;
      } else if (ev.type === 'sanity') { setStage('sanity'); msg.textContent = ev.flagged ? `Setting aside ${ev.flagged} offer(s) whose price cannot be believed…` : 'Checking that the matching prices are believable…'; }
      else if (ev.type === 'economics') { setStage('economics'); msg.textContent = 'Working out landed cost, fees and the resale gap…'; }
      else if (ev.type === 'briefing') { setStage('briefing'); msg.textContent = 'Writing a short note from the verified numbers…'; }
    },
  };
}

// Runs one check against the streaming endpoint and resolves with the finished analysis.
export async function streamAnalysis(query: string, market: string, onEvent: (ev: any) => void): Promise<any> {
  const res = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ query, market }) });
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `Request failed (${res.status})`); }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let analysis: any = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === 'error') throw new Error(ev.message);
      if (ev.type === 'done') analysis = ev.analysis; else onEvent(ev);
    }
  }
  if (!analysis) throw new Error('The analysis ended without a result.');
  return analysis;
}
