// All listing text is untrusted, so the page is built with textContent only. innerHTML is used solely for our own constant icons.
const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const money = (cents, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(cents / 100);
const money0 = (cents, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(cents / 100);
const pct = (bps) => `${(bps / 100).toFixed(1)}%`;
const int = (n) => new Intl.NumberFormat('en-US').format(n);

function safeLink(url, label, props = {}) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') return h('a', { href: u.href, target: '_blank', rel: 'noopener noreferrer', ...props }, label);
  } catch { /* fall through */ }
  return h('span', props, label);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { body, status: res.status });
  return body;
}

let status = null;
let current = null;

/* ───────────── status, hero, stats ───────────── */

function renderStatus() {
  $('status-text').textContent = `${status.model} · ${status.quota.used}/${status.quota.limit} searches`;
}

const verdictLabel = (s) => ({ profitable: 'Arbitrage clears', thin: 'Thin margin', loss: 'No arbitrage', unverified: 'Too good to verify', 'no-reference': 'Nothing to resell against', none: 'No identical product' })[s] ?? s;

let stageTimer = null;
function renderStage(items) {
  const ring = $('stage-ring');
  const rail = $('rail');
  const caps = $('captions');
  clearTimeout(stageTimer);
  if (!items.length) {
    ring.replaceChildren(h('div', { class: 'tile is-front' }, h('span', { class: 'ph' }, 'SKU')));
    rail.replaceChildren();
    caps.replaceChildren(h('div', { class: 'cap on' }, h('p', { class: 'cap-name' }, 'Run the desk to see a real check here'), h('p', { class: 'cap-line' }, 'Every card on this stage is a real, stored analysis.')));
    return;
  }
  const n = items.length;
  const tiles = items.map((it, i) => h('button', { type: 'button', class: 'tile', 'aria-label': `Show ${it.query}`, on: { click: () => show(i) } },
    it.thumbnail ? h('img', { src: it.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'ph' }, '∅')));
  ring.replaceChildren(...tiles);
  rail.replaceChildren(...items.map(() => h('i')));
  caps.replaceChildren(...items.map((it) => {
    const line = it.buy ? `Cheapest identical: ${money(it.buy.landedCents, it.currency)} at ${it.buy.seller}` : `${it.considered} listings checked, none identical`;
    const net = it.netCents !== null && it.verdict !== 'unverified' ? (it.netCents >= 0 ? `Net +${money(it.netCents, it.currency)} after all costs` : `Resale would lose ${money(-it.netCents, it.currency)}`) : verdictLabel(it.verdict);
    return h('article', { class: 'cap' },
      h('p', { class: 'cap-name' }, it.query),
      h('p', { class: 'cap-tag' }, it.identical ? `✓ ${it.identical} identical of ${it.considered}` : '✗ Nothing provably the same'),
      h('p', { class: 'cap-line' }, line),
      h('p', { class: 'cap-net' }, net),
      h('button', { type: 'button', class: 'cap-go', on: { click: () => openAnalysis(it.id) } }, 'Open this check →'));
  }));
  let front = 0;
  function show(i) {
    front = i;
    const half = Math.floor(n / 2);
    tiles.forEach((t, k) => {
      const d = ((k - front + n + half) % n) - half;
      const abs = Math.abs(d);
      t.classList.toggle('is-front', d === 0);
      t.style.transform = `translateX(${d * 96}px) scale(${1 - abs * 0.13})`;
      t.style.opacity = abs > 2 ? '0' : String(1 - abs * 0.3);
      t.style.zIndex = String(10 - abs);
      t.style.pointerEvents = abs > 2 ? 'none' : 'auto';
    });
    [...rail.children].forEach((r, k) => r.classList.toggle('on', k === front));
    [...caps.children].forEach((c, k) => c.classList.toggle('on', k === front));
  }
  show(0);
  const tick = () => { stageTimer = setTimeout(() => { show((front + 1) % n); tick(); }, 4800); };
  if (!reduceMotion && n > 1) {
    tick();
    ring.onpointerenter = () => clearTimeout(stageTimer);
    ring.onpointerleave = () => { clearTimeout(stageTimer); tick(); };
  }
}

function countUp(el, target, fmt) {
  if (reduceMotion || !('IntersectionObserver' in window)) { el.textContent = fmt(target); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(el);
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / 1100);
        el.textContent = fmt(p >= 1 ? target : Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }, { threshold: 0.6 });
  io.observe(el);
}

function tile(value, label, sub, fmt = int, good = false) {
  const v = h('b', { class: `tr-v${good ? ' good' : ''}` }, fmt(value));
  countUp(v, value, fmt);
  return h('li', { class: 'tr-tile' }, v, h('span', { class: 'tr-k' }, label), sub ? h('small', { class: 'tr-sub' }, sub) : null);
}

function renderImpact(i) {
  $('impact').replaceChildren(
    tile(i.products, 'Products checked'),
    tile(i.listings, 'Listings screened'),
    tile(i.rejected, 'Rejected by the gate', 'not the same item'),
    tile(i.flagged, 'Bad prices set aside', 'same item, unbelievable price'),
    tile(i.phantomCents, 'Fake discount blocked', 'below the believable price', (c) => money0(c)));
}

function renderEval(ev) {
  if (!ev) { $('evidence').hidden = true; return; }
  const safe = ev.pairs - ev.exact - ev.falseIdentical - ev.missedIdentical;
  $('ev-lead').textContent = `${ev.pairs} hand-labelled product pairs, run against ${ev.model} on ${new Date(ev.ranAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}.`;
  $('ev-grid').replaceChildren(
    tile(ev.falseIdentical, 'False matches', 'passed the gate but should not have', int, true),
    tile(ev.pairs, 'Labelled pairs'),
    tile(ev.exact, 'Exact answers', `of ${ev.pairs}`),
    tile(safe, 'Safe disagreements', 'labelled different, answered uncertain'));
}

const ICONS = {
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  model: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  verify: '<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  price: '<path d="M4 18l5-6 4 3 7-9"/><path d="M4 21h16"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 13h2M13 13h2M9 17h2M13 17h2"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M5 21c1-4 4-6 7-6s6 2 7 6"/>',
};

function renderFlow() {
  const nodes = [
    ['on', 'search', 'Search', 'Google Shopping through SerpApi. Every paid call is cached and capped each month.'],
    ['off', 'model', 'Gemini reads', 'Compares each listing with your product and quotes the brand and set number it relied on.'],
    ['on', 'verify', 'Evidence check', 'Code confirms the quotes are really in the listing. No quote, no match.'],
    ['on', 'price', 'Price sanity', 'Offers far below the median, or under half the recalled retail price, are set aside.'],
    ['on', 'calc', 'Economics', 'Landed cost, fees, shipping and a margin floor in integer cents. An honest no is a result.'],
    ['on', 'person', 'You approve', 'The agent files a proposal. A person approves it. No payment details are held.'],
  ];
  $('flow').replaceChildren(...nodes.map(([zone, icon, title, text], i) => {
    const li = h('li', { class: 'pf-node', 'data-zone': zone },
      h('span', { class: 'pf-ic' }), h('div', { class: 'pf-tx' }, h('b', {}, title), h('p', {}, text)),
      i < nodes.length - 1 ? h('i', { class: 'pf-dot', 'aria-hidden': 'true' }) : null);
    li.style.setProperty('--i', String(i));
    li.querySelector('.pf-ic').innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon]}</svg>`;
    return li;
  }));
}

/* ───────────── the desk ───────────── */

const thumbOf = (o) => h('span', { class: 'thumb' }, o.thumbnail ? h('img', { src: o.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null);

function offerRow(p, cur, mode) {
  const o = p.offer;
  const sub = [o.seller, o.channel];
  if (mode !== 'rejected') sub.push(p.shippingAssumed ? 'shipping assumed' : (o.shippingCents === 0 ? 'free shipping' : `shipping ${money(o.shippingCents, cur)}`));
  const pills = [];
  if (mode === 'identical') {
    pills.push(h('span', { class: 'pill good' }, `identical ${Math.round(p.confidence * 100)}%`));
    if (p.quoted?.brandQuote) pills.push(h('span', { class: 'pill q' }, `brand “${p.quoted.brandQuote}”`));
    if (p.quoted?.idQuote) pills.push(h('span', { class: 'pill q' }, `number “${p.quoted.idQuote}”`));
  } else if (mode === 'flagged') {
    pills.push(h('span', { class: 'pill warn' }, 'price looks wrong'));
  } else {
    pills.push(h('span', { class: `pill ${p.verdict === 'different' ? 'bad' : 'warn'}` }, p.verdict));
  }
  const why = mode === 'flagged'
    ? (p.reason === 'retail' ? `under half of the ${money(p.referenceCents, cur)} retail price Gemini recalls` : `under 40% of the ${money(p.referenceCents, cur)} median identical price`) + ', treated as a data error'
    : mode === 'identical' ? p.reasons[0] : (p.mismatches[0] || p.reasons[0]);
  return h('div', { class: 'offer' }, thumbOf(o),
    h('div', { class: 't' }, o.url ? safeLink(o.url, o.title) : h('span', { class: 'title' }, o.title), h('div', { class: 's' }, sub.join(' · '), why ? ` — ${why}` : ''), h('div', { class: 'pills' }, pills)),
    h('div', { class: 'p' }, money(mode === 'rejected' ? o.priceCents : p.landedCents, cur)));
}

function stepsTable(steps, cur, total) {
  return h('table', { class: 'kv' }, h('tbody', {},
    steps.filter((s) => s.cents !== 0 || s.label === 'price').map((s) => h('tr', { class: /fee|reserve|outbound/.test(s.label) ? 'neg' : '' }, h('td', {}, s.label), h('td', {}, money(s.cents, cur)))),
    total ? h('tr', { class: 'total' }, h('td', {}, total.label), h('td', {}, money(total.cents, cur))) : null));
}

function cards(a) {
  const cur = a.currency;
  const buy = a.buy
    ? h('div', { class: 'card' }, h('h3', {}, 'Buy'), h('div', { class: 'big' }, money(a.buy.landedCents, cur)), h('p', { class: 'muted sm' }, `landed at ${a.buy.offer.seller}`), stepsTable(a.buy.steps, cur, { label: 'landed cost', cents: a.buy.landedCents }))
    : h('div', { class: 'card' }, h('h3', {}, 'Buy'), h('p', { class: 'empty' }, 'No identical sealed item cleared the gate, so there is nothing safe to buy.'));
  const sell = a.sell
    ? h('div', { class: 'card' }, h('h3', {}, 'Sell'), h('div', { class: 'big' }, money(a.sell.listAtCents, cur)), h('p', { class: 'muted sm' }, 'cheapest identical price you must match'),
      h('table', { class: 'kv' }, h('tbody', {},
        h('tr', { class: 'neg' }, h('td', {}, 'marketplace fee'), h('td', {}, `-${money(a.sell.feeCents, cur)}`)),
        h('tr', { class: 'neg' }, h('td', {}, 'return reserve'), h('td', {}, `-${money(a.sell.reserveCents, cur)}`)),
        h('tr', { class: 'neg' }, h('td', {}, 'outbound shipping'), h('td', {}, `-${money(a.sell.outboundShippingCents, cur)}`)),
        h('tr', { class: 'total' }, h('td', {}, 'you keep, before your purchase cost'), h('td', {}, money(a.sell.netBeforeCostCents, cur))))))
    : h('div', { class: 'card' }, h('h3', {}, 'Sell'), h('p', { class: 'empty' }, 'No identical listing to price against.'));
  let arb;
  if (a.arbitrage) {
    const r = a.arbitrage;
    const pill = r.implausible ? h('span', { class: 'pill warn' }, 'unverified') : h('span', { class: `pill ${r.verdict === 'profitable' ? 'good' : r.verdict === 'thin' ? 'warn' : 'bad'}` }, r.verdict);
    arb = h('div', { class: 'card' }, h('h3', {}, 'Arbitrage'), h('div', { class: `big ${r.netCents < 0 ? 'neg' : 'pos'}` }, money(r.netCents, cur)),
      h('p', { class: 'muted sm' }, 'net after all costs ', pill, ` ${pct(r.marginBps)}`), stepsTable(r.steps, cur, null));
  } else {
    arb = h('div', { class: 'card' }, h('h3', {}, 'Arbitrage'), h('p', { class: 'empty' }, a.buy ? 'No second identical price to resell against.' : 'None. The gate found no identical product.'));
  }
  return [buy, sell, arb];
}

function barTrack(frac) {
  const bar = h('div', { class: 'bar' });
  bar.style.width = `${Math.max(2, Math.min(100, frac * 100))}%`;
  return h('div', { class: 'bar-track' }, bar);
}

function ladder(a) {
  const cur = a.currency;
  const rows = [...a.identical.map((p) => ({ p, kind: '' })), ...a.flagged.map((p) => ({ p, kind: 'flag' }))].sort((x, y) => x.p.landedCents - y.p.landedCents);
  const max = Math.max(a.retailCents ?? 0, ...rows.map((r) => r.p.landedCents), 1);
  const out = [];
  if (a.retailCents) out.push(h('div', { class: 'ladder-row ref' }, h('span', { class: 'lbl' }, 'Retail (recalled)'), barTrack(a.retailCents / max), h('span', { class: 'val' }, money(a.retailCents, cur))));
  rows.forEach(({ p, kind }) => {
    const best = Boolean(a.buy) && p.offer.id === a.buy.offer.id && p.offer.seller === a.buy.offer.seller && p.offer.priceCents === a.buy.offer.priceCents;
    out.push(h('div', { class: `ladder-row ${kind} ${best ? 'best' : ''}` }, h('span', { class: 'lbl', title: p.offer.title }, p.offer.seller), barTrack(p.landedCents / max), h('span', { class: 'val' }, money(p.landedCents, cur))));
  });
  $('ladder').replaceChildren(...out);
  $('ladder-sum').textContent = rows.length
    ? `Landed cost of every offer that matched the product. Amber bars are prices not trusted${a.retailCents ? '; the dashed bar is the retail price Gemini recalls' : ''}.`
    : 'No offer matched the product, so there is nothing to place on a ladder.';
  $('ladder').closest('.card').hidden = rows.length === 0;
}

function verdictTone(a) {
  if (!a.buy || !a.arbitrage) return 'none';
  if (a.arbitrage.implausible) return 'warn';
  return a.arbitrage.verdict === 'profitable' ? 'good' : a.arbitrage.verdict === 'thin' ? 'warn' : 'none';
}

async function renderApproval(a) {
  const panel = $('approval-panel');
  if (!a.proposalId) { panel.hidden = true; return; }
  const list = await api('/api/proposals').catch(() => []);
  const p = list.find((x) => x.id === a.proposalId);
  if (!p) { panel.hidden = true; return; }
  panel.hidden = false;
  const draw = (q) => {
    const wrap = h('div', { class: 'approval' }, h('div', {}, h('strong', {}, q.title), h('div', { class: 'muted sm' }, `${q.seller} · ${money(q.landedCents, q.currency)} landed`)));
    if (q.status === 'pending') {
      const act = async (decision) => {
        wrap.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try { draw(await api(`/api/proposals/${q.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) })); }
        catch (e) { draw(e.body?.proposal ?? q); showError(e.message); }
      };
      wrap.append(h('p', { class: 'muted sm' }, 'SKUdesk will not spend anything. Approving unlocks the seller link; you pay on the seller’s site.'),
        h('div', { class: 'acts' }, h('button', { class: 'btn', type: 'button', on: { click: () => act('approved') } }, 'Approve'), h('button', { class: 'btn ghost', type: 'button', on: { click: () => act('rejected') } }, 'Reject')));
    } else if (q.status === 'approved') {
      wrap.append(h('div', { class: 'row' }, h('span', { class: 'pill good' }, 'approved'), q.url ? safeLink(q.url, 'Open the seller page') : 'No link available'));
    } else {
      wrap.append(h('div', { class: 'row' }, h('span', { class: 'pill' }, 'rejected'), h('span', { class: 'muted' }, 'Nothing was bought.')));
    }
    $('approval').replaceChildren(wrap);
  };
  draw(p);
}

async function renderResult(a, { scroll = true } = {}) {
  current = a;
  $('result').hidden = false;
  const tone = verdictTone(a);
  const v = $('verdict');
  v.className = `verdict ${tone}`;
  v.replaceChildren(
    h('span', { class: 'v-tag' }, tone === 'good' ? 'Arbitrage clears' : tone === 'warn' ? 'Handle with care' : a.buy ? 'Honest answer' : 'Nothing to trade'),
    h('p', { class: 'v-text' }, a.headline),
    h('p', { class: 'v-sub' }, `${a.query} · ${a.market.toUpperCase()} · ${a.searched} listings returned${a.fromCache ? ' · cached search, no new quota used' : ''}`));
  $('cards').replaceChildren(...cards(a));
  $('note-panel').hidden = !a.briefing;
  if (a.briefing) $('note-text').textContent = a.briefing;
  ladder(a);
  const g = a.gate;
  $('gate-sum').textContent = `${g.considered} listings checked by ${a.model}: ${g.identical} identical, ${g.different} different, ${g.uncertain} uncertain.`;
  const total = Math.max(g.considered, 1);
  $('gate-bar').replaceChildren(...[['a', g.identical], ['b', g.different], ['c', g.uncertain]].map(([c, n]) => { const i = h('i', { class: c }); i.style.width = `${(n / total) * 100}%`; return i; }));
  $('identical').replaceChildren(...(a.identical.length ? a.identical.map((p) => offerRow(p, a.currency, 'identical')) : [h('p', { class: 'muted sm' }, 'None. The gate would rather say no than guess.')]));
  $('flagged-box').hidden = !a.flagged.length;
  $('flagged').replaceChildren(...a.flagged.map((p) => offerRow(p, a.currency, 'flagged')));
  $('rejected-sum').textContent = `Rejected listings (${g.different + g.uncertain}) — why they did not pass`;
  $('rejected').replaceChildren(...a.rejected.map((p) => offerRow(p, a.currency, 'rejected')));
  $('notes').replaceChildren(...a.notes.map((n) => h('li', {}, n)));
  const s = a.assumptions;
  $('assump-list').textContent = `Defaults: marketplace fee ${pct(s.marketplaceFeeBps)}, return reserve ${pct(s.returnReserveBps)}, outbound shipping ${money(s.outboundShippingCents, a.currency)}, unknown inbound shipping ${money(s.unknownShippingCents, a.currency)}, margin floor ${pct(s.minMarginBps)}.`;
  await renderApproval(a);
  if (scroll) $('verdict').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}

function showError(msg) { const e = $('error'); e.textContent = msg; e.hidden = !msg; }

const STAGES = ['search', 'gate', 'sanity', 'economics', 'briefing'];
function setStage(name, doneAll = false) {
  const at = STAGES.indexOf(name);
  document.querySelectorAll('.stage-step').forEach((el, i) => {
    el.classList.toggle('done', doneAll || i < at);
    el.classList.toggle('act', !doneAll && i === at);
  });
}

function addChip(ev) {
  $('wall').append(h('div', { class: `chip ${ev.verdict}`, title: `${ev.seller}: ${ev.title}` }, ev.thumbnail ? h('img', { src: ev.thumbnail, alt: '', referrerpolicy: 'no-referrer' }) : null, h('i')));
}

function handle(ev) {
  if (ev.type === 'search') { setStage('gate'); $('run-msg').textContent = `Found ${ev.listings} listings${ev.fromCache ? ' (cached search)' : ''}. Asking Gemini whether each one is the identical product…`; }
  else if (ev.type === 'gate') { addChip(ev); $('run-msg').textContent = `Judged ${ev.done} of ${ev.total}. Green passes, red is a different product, amber is not provable.`; }
  else if (ev.type === 'sanity') { setStage('sanity'); $('run-msg').textContent = ev.flagged ? `Setting aside ${ev.flagged} offer(s) whose price cannot be believed…` : 'Checking that the matching prices are believable…'; }
  else if (ev.type === 'economics') { setStage('economics'); $('run-msg').textContent = 'Working out landed cost, fees and the resale gap…'; }
  else if (ev.type === 'briefing') { setStage('briefing'); $('run-msg').textContent = 'Writing a short note from the verified numbers…'; }
}

async function run(query, market) {
  showError('');
  $('go').disabled = true;
  $('result').hidden = true;
  $('run').hidden = false;
  $('wall').replaceChildren();
  setStage('search');
  $('run-msg').textContent = 'Searching Google Shopping…';
  try {
    const res = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ query, market }) });
    if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `Request failed (${res.status})`); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let analysis = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'error') throw new Error(ev.message);
        if (ev.type === 'done') analysis = ev.analysis; else handle(ev);
      }
    }
    if (!analysis) throw new Error('The analysis ended without a result.');
    setStage('briefing', true);
    await renderResult(analysis);
    refreshStatus(); refreshScans(); refreshImpact(); refreshShowcase();
  } catch (e) {
    showError(e.message);
  } finally {
    $('go').disabled = false;
    $('run').hidden = true;
  }
}

async function openAnalysis(id) {
  try {
    await renderResult(await api(`/api/analyses/${id}`));
  } catch (e) { showError(e.message); }
}

async function refreshStatus() { status = await api('/api/status'); renderStatus(); }
async function refreshImpact() { renderImpact(await api('/api/impact').catch(() => ({ products: 0, listings: 0, rejected: 0, flagged: 0, phantomCents: 0 }))); }
async function refreshShowcase() {
  const list = await api('/api/analyses').catch(() => []);
  const seen = new Set();
  renderStage(list.filter((a) => { const k = `${a.query.toLowerCase()}|${a.market}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 7));
}

async function refreshScans() {
  const scans = await api('/api/scans').catch(() => []);
  const items = scans.flatMap((s) => s.done.map((d) => ({ ...d, at: s.createdAt })));
  $('scans-panel').hidden = items.length === 0;
  $('scans').replaceChildren(...items.slice(0, 6).map((d) => h('button', { type: 'button', class: 'offer btnrow', on: { click: () => openAnalysis(d.id) } },
    h('span', { class: 'thumb' }), h('div', { class: 't' }, h('span', { class: 'title' }, `${d.query} (${d.market.toUpperCase()})`), h('div', { class: 's' }, `${new Date(d.at).toLocaleString()} · ${d.headline}`)), h('span', { class: 'p' }, '→'))));
}

function download() {
  if (!current) return;
  const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `skudesk-${current.id}.json` });
  document.body.append(a); a.click(); a.remove();
}

async function init() {
  const sel = $('market');
  $('form').addEventListener('submit', (ev) => { ev.preventDefault(); run($('query').value.trim(), sel.value); });
  $('dl').addEventListener('click', download);
  renderFlow();
  const [, , , ev] = await Promise.all([refreshStatus(), refreshImpact(), refreshShowcase(), api('/api/eval').catch(() => null)]);
  renderEval(ev);
  const chosen = sel.value;
  sel.replaceChildren(...status.markets.map((m) => h('option', { value: m.code }, `${m.label} (${m.currency})`)));
  sel.value = chosen;
  const picks = status.watchlist.length ? status.watchlist : [{ query: 'LEGO 10294 Titanic', market: 'us' }];
  $('examples').replaceChildren(h('span', { class: 'muted sm' }, 'Try:'), ...picks.map((w) => h('button', { type: 'button', on: { click: () => { $('query').value = w.query; sel.value = w.market; $('form').requestSubmit(); } } }, w.query)));
  refreshScans();
}

init().catch((e) => { $('status-text').textContent = 'Offline'; showError(e.message); });
