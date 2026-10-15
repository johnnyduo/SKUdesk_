// All listing text is untrusted, so the page is built with textContent only, never innerHTML.
const $ = (id) => document.getElementById(id);

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

const money = (cents, cur) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(cents / 100);
const pct = (bps) => `${(bps / 100).toFixed(1)}%`;

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

function renderStatus() {
  const box = $('status');
  box.replaceChildren(
    h('span', { class: 'chip ok' }, `Gemini ${status.model}`),
    h('span', { class: `chip ${status.sources.ebay ? 'ok' : 'off'}` }, status.sources.ebay ? 'Google Shopping + eBay' : 'Google Shopping'),
    h('span', { class: 'chip' }, `Searches this month ${status.quota.used}/${status.quota.limit}`),
    h('span', { class: 'chip' }, status.store),
  );
}

function offerRow(p, cur, mode) {
  const o = p.offer;
  const sub = [];
  sub.push(o.seller);
  sub.push(o.channel === 'marketplace' ? 'marketplace' : 'retailer');
  if (mode === 'identical' || mode === 'flagged') {
    sub.push(p.shippingAssumed ? `shipping assumed` : (o.shippingCents === 0 ? 'free shipping' : `shipping ${money(o.shippingCents, cur)}`));
  }
  const tag = mode === 'identical'
    ? h('span', { class: 'tag good' }, `identical ${Math.round(p.confidence * 100)}%`)
    : mode === 'flagged'
    ? h('span', { class: 'tag warn' }, 'price looks wrong')
    : h('span', { class: `tag ${p.verdict === 'different' ? 'bad' : 'warn'}` }, p.verdict);
  const why = mode === 'flagged' ? (p.reason === 'retail' ? `under half of the ${money(p.referenceCents, cur)} retail price Gemini recalls` : `under 40% of the ${money(p.referenceCents, cur)} median identical price`) + ', treated as a data error' : mode === 'identical' ? p.reasons[0] : (p.mismatches[0] || p.reasons[0]);
  return h('div', { class: 'row' },
    h('div', { class: 't' }, o.url ? safeLink(o.url, o.title) : o.title, tag),
    h('div', { class: 'p' }, mode === 'identical' || mode === 'flagged' ? money(p.landedCents, cur) : money(o.priceCents, cur)),
    h('div', { class: 's' }, sub.join(' · '), why ? ` — ${why}` : ''),
  );
}

function stepsTable(steps, cur, total) {
  return h('table', { class: 'kv' },
    h('tbody', {}, steps.filter((s) => s.cents !== 0 || s.label === 'price').map((s) => h('tr', { class: s.label.startsWith('outbound') || s.label.includes('fee') || s.label.includes('reserve') ? 'neg' : '' }, h('td', {}, s.label), h('td', {}, money(s.cents, cur)))),
      total ? h('tr', { class: 'total' }, h('td', {}, total.label), h('td', {}, money(total.cents, cur))) : null));
}

function cards(a) {
  const cur = a.currency;
  const buy = a.buy
    ? h('div', { class: 'card' }, h('h2', {}, 'Buy'), h('div', { class: 'big' }, money(a.buy.landedCents, cur)), h('p', { class: 'muted' }, `landed at ${a.buy.offer.seller}`), stepsTable(a.buy.steps, cur, { label: 'landed cost', cents: a.buy.landedCents }))
    : h('div', { class: 'card' }, h('h2', {}, 'Buy'), h('p', { class: 'empty' }, 'No identical sealed item cleared the gate, so there is nothing safe to buy.'));
  const sell = a.sell
    ? h('div', { class: 'card' }, h('h2', {}, 'Sell'), h('div', { class: 'big' }, money(a.sell.listAtCents, cur)), h('p', { class: 'muted' }, 'cheapest identical price you must match'),
      h('table', { class: 'kv' }, h('tbody', {},
        h('tr', { class: 'neg' }, h('td', {}, 'marketplace fee'), h('td', {}, `-${money(a.sell.feeCents, cur)}`)),
        h('tr', { class: 'neg' }, h('td', {}, 'return reserve'), h('td', {}, `-${money(a.sell.reserveCents, cur)}`)),
        h('tr', { class: 'neg' }, h('td', {}, 'outbound shipping'), h('td', {}, `-${money(a.sell.outboundShippingCents, cur)}`)),
        h('tr', { class: 'total' }, h('td', {}, 'you keep, before your purchase cost'), h('td', {}, money(a.sell.netBeforeCostCents, cur))))))
    : h('div', { class: 'card' }, h('h2', {}, 'Sell'), h('p', { class: 'empty' }, 'No identical listing to price against.'));
  let arb;
  if (a.arbitrage) {
    const r = a.arbitrage;
    const tone = r.implausible ? 'warn' : r.verdict === 'profitable' ? 'good' : r.verdict === 'thin' ? 'warn' : 'bad';
    arb = h('div', { class: 'card' }, h('h2', {}, 'Arbitrage'), h('div', { class: 'big' }, money(r.netCents, cur)), h('p', { class: 'muted' }, `net after all costs `, h('span', { class: `tag ${tone}` }, r.implausible ? 'unverified' : r.verdict), ` ${pct(r.marginBps)}`),
      stepsTable(r.steps, cur, null));
  } else {
    arb = h('div', { class: 'card' }, h('h2', {}, 'Arbitrage'), h('p', { class: 'empty' }, a.buy ? 'No second identical price to resell against.' : 'None. The gate found no identical product.'));
  }
  return [buy, sell, arb];
}

function tone(a) {
  if (!a.buy) return 'none';
  if (!a.arbitrage) return 'none';
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
    const box = $('approval');
    const body = [h('div', { class: 'approval' },
      h('div', {}, h('strong', {}, q.title), h('div', { class: 'muted' }, `${q.seller} · ${money(q.landedCents, q.currency)} landed`)),
    )];
    const wrap = body[0];
    if (q.status === 'pending') {
      const act = async (decision) => {
        wrap.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        try { draw(await api(`/api/proposals/${q.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) })); }
        catch (e) { draw(e.body?.proposal ?? q); showError(e.message); }
      };
      wrap.append(h('div', { class: 'muted' }, 'SKUdesk will not spend anything. Approving unlocks the seller link; you pay on the seller’s site.'),
        h('div', { class: 'acts' }, h('button', { class: 'good', type: 'button', on: { click: () => act('approved') } }, 'Approve'), h('button', { type: 'button', on: { click: () => act('rejected') } }, 'Reject')));
    } else if (q.status === 'approved') {
      wrap.append(h('div', {}, h('span', { class: 'tag good' }, 'approved'), ' ', q.url ? safeLink(q.url, 'Open the seller page') : 'No link available'));
    } else {
      wrap.append(h('div', {}, h('span', { class: 'tag none' }, 'rejected'), ' Nothing was bought.'));
    }
    box.replaceChildren(...body);
  };
  draw(p);
}

async function renderResult(a) {
  $('result').hidden = false;
  const hl = $('headline');
  hl.className = `headline ${tone(a)}`;
  hl.replaceChildren(a.headline, h('small', {}, `${a.query} · ${a.market.toUpperCase()} · ${a.searched} listings returned${a.fromCache ? ' (cached search, no new quota used)' : ''}`));
  $('cards').replaceChildren(...cards(a));
  const g = a.gate;
  $('gate-sum').textContent = `${g.considered} listings checked by ${a.model}: ${g.identical} identical, ${g.different} different, ${g.uncertain} uncertain.`;
  const total = Math.max(g.considered, 1);
  $('gate-bar').replaceChildren(
    ...[['a', g.identical], ['b', g.different], ['c', g.uncertain]].map(([c, n]) => { const i = h('i', { class: c }); i.style.width = `${(n / total) * 100}%`; return i; }));
  $('identical').replaceChildren(...(a.identical.length ? a.identical.map((p) => offerRow(p, a.currency, 'identical')) : [h('p', { class: 'muted' }, 'None. The gate would rather say no than guess.')]));
  $('flagged-box').hidden = !a.flagged.length;
  $('flagged').replaceChildren(...a.flagged.map((p) => offerRow(p, a.currency, 'flagged')));
  $('rejected-sum').textContent = `Rejected listings (${g.different + g.uncertain}) — why they did not pass`;
  $('rejected').replaceChildren(...a.rejected.map((p) => offerRow(p, a.currency, 'rejected')));
  $('notes').replaceChildren(...a.notes.map((n) => h('li', {}, n)));
  const s = a.assumptions;
  $('assump-list').textContent = `Defaults: marketplace fee ${pct(s.marketplaceFeeBps)}, return reserve ${pct(s.returnReserveBps)}, outbound shipping ${money(s.outboundShippingCents, a.currency)}, unknown inbound shipping ${money(s.unknownShippingCents, a.currency)}, margin floor ${pct(s.minMarginBps)}.`;
  await renderApproval(a);
  $('result').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function showError(msg) { const e = $('error'); e.textContent = msg; e.hidden = !msg; }

async function run(query, market) {
  showError('');
  $('go').disabled = true;
  $('busy').hidden = false;
  $('busy-text').textContent = 'Searching listings, then asking Gemini whether each one is the identical product…';
  try {
    const a = await api('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, market }) });
    await renderResult(a);
    refreshStatus();
    refreshScans();
  } catch (e) {
    showError(e.message);
  } finally {
    $('go').disabled = false;
    $('busy').hidden = true;
  }
}

async function refreshStatus() { status = await api('/api/status'); renderStatus(); }

async function refreshScans() {
  const scans = await api('/api/scans').catch(() => []);
  const items = scans.flatMap((s) => s.done.map((d) => ({ ...d, at: s.createdAt })));
  const panel = $('scans-panel');
  panel.hidden = items.length === 0;
  $('scans').replaceChildren(...items.slice(0, 6).map((d) => h('button', { type: 'button', class: 'scan', on: { click: async () => { try { await renderResult(await api(`/api/analyses/${d.id}`)); } catch (e) { showError(e.message); } } } },
    h('b', {}, `${d.query} (${d.market.toUpperCase()})`), h('span', {}, `${new Date(d.at).toLocaleString()} · ${d.headline}`))));
}

async function init() {
  const sel = $('market');
  // Listen first so a quick submit is never lost to a full-page form post while the status request is in flight.
  $('form').addEventListener('submit', (ev) => { ev.preventDefault(); run($('query').value.trim(), sel.value); });
  await refreshStatus();
  const chosen = sel.value;
  sel.replaceChildren(...status.markets.map((m) => h('option', { value: m.code }, `${m.label} (${m.currency})`)));
  sel.value = chosen;
  const ex = $('examples');
  const picks = status.watchlist.length ? status.watchlist : [{ query: 'LEGO 10294 Titanic', market: 'us' }];
  ex.replaceChildren(h('span', { class: 'muted' }, 'Try:'), ...picks.map((w) => h('button', { type: 'button', on: { click: () => { $('query').value = w.query; sel.value = w.market; $('form').requestSubmit(); } } }, w.query)));
  refreshScans();
}

init().catch((e) => showError(e.message));
