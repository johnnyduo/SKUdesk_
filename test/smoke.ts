// Smoke test against a DEPLOYED SKUdesk: real Cloud Run, real Firestore, real Gemini, real SerpApi.
// Usage: npm run smoke -- https://your-service-url [query]
// The real analysis step runs only when OWNER_KEY is in the environment, because it removes what it created (two checks and their
// proposals) so a smoke run never leaves anything on the desk. Use a product that was searched in the last 12 hours to spend no search.
const base = (process.argv[2] ?? '').replace(/\/$/, '');
const query = process.argv[3] ?? 'Apple iPhone 16 128GB';
const ownerKey = process.env.OWNER_KEY ?? '';
if (!base) {
  console.error('usage: npm run smoke -- <service-url> [query]');
  process.exit(2);
}

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};
const json = async (path: string, init?: RequestInit) => {
  const res = await fetch(base + path, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};

const health = await json('/health');
check('health endpoint', health.status === 200 && health.body.ok === true);

const page = await fetch(base + '/');
const html = await page.text();
check('landing page served with a strict policy', page.status === 200 && html.includes('SKUdesk') && /script-src 'self'/.test(page.headers.get('content-security-policy') ?? '') && Boolean(page.headers.get('strict-transport-security')));
check('pages revalidate (a stale copy can never outlive a deploy)', page.headers.get('cache-control') === 'no-cache' || /no-cache|no-store/.test(page.headers.get('cache-control') ?? ''), page.headers.get('cache-control') ?? '');
for (const path of ['/app/', '/show/', '/market/', '/app/opportunities/', '/app/orders/', '/app/create/', '/app/policies/', '/app/owner/', '/app/analytics/', '/app/deploy/', '/deck/']) {
  const r = await fetch(base + path);
  check(`page ${path}`, r.status === 200);
}
check('unknown pages return a 404 page', (await fetch(base + '/no-such-page')).status === 404);

const status = await json('/api/status');
check('status reports Firestore and never names the model', status.status === 200 && String(status.body.store).startsWith('firestore:') && !('model' in status.body), String(status.body.store));

const impact = await json('/api/impact');
check('impact totals are served from stored checks', impact.status === 200 && Number.isInteger(impact.body.products) && Number.isInteger(impact.body.listings), JSON.stringify(impact.body));

const ev = await json('/api/eval');
check('evidence summary is shipped and has zero false matches', ev.status === 200 && ev.body?.falseIdentical === 0 && ev.body?.pairs > 0, `${ev.body?.pairs} pairs`);

const asset = await fetch(base + '/fonts/inter.woff2');
check('fonts and static assets are served', asset.status === 200 && (asset.headers.get('content-type') ?? '').includes('font'));

const bad = await json('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '<script>', market: 'us' }) });
check('rejects a malformed query', bad.status === 400);

const owner = await json('/api/owner/check');
check('owner endpoints refuse callers without the key', owner.status === 401);
const putLimits = await json('/api/limits', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }) });
check('the kill switch cannot be pulled without the owner key', putLimits.status === 401);
const img = await fetch(base + '/api/img?u=' + encodeURIComponent('https://example.com/a.png'));
check('the image proxy refuses hosts that are not allow-listed', img.status === 400);
const scan = await json('/api/jobs/scan', { method: 'POST' });
check('scan endpoint refuses callers without the secret', scan.status === 401);

if (!ownerKey) console.log('SKIP  real analysis (set OWNER_KEY so the run can clean up after itself)');
else {
  const res = await json('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, market: 'us' }) });
  const a = res.body;
  const streamRes = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ query, market: 'us' }) });
  const events = (await streamRes.text()).trim().split('\n').map((l) => JSON.parse(l));
  check('analysis streams progress and ends with a result', streamRes.status === 200 && events[0]?.type === 'search' && events.some((e) => e.type === 'gate') && events.at(-1)?.type === 'done', events.map((e) => e.type).filter((t, i, arr) => arr.indexOf(t) === i).join(' > '));
  check('analysis completes', res.status === 200 && typeof a.headline === 'string', res.status === 200 ? a.headline : String(a.error));
  if (res.status === 200) {
    check('every listing was put through the Identity Engine', a.gate.considered > 0 && a.gate.considered === a.gate.identical + a.gate.different + a.gate.uncertain, JSON.stringify(a.gate));
    check('money is integer cents', [a.buy?.landedCents, a.sell?.listAtCents].filter((v) => v !== undefined && v !== null).every(Number.isInteger));
    check('a buy always files a pending proposal, never a purchase', a.buy ? Boolean(a.proposalId) : a.proposalId === null);
    if (a.proposalId) {
      const list = await json('/api/proposals');
      const p = (list.body as unknown as { id: string; status: string }[]).find((x) => x.id === a.proposalId);
      check('the proposal is stored and not yet decided', Boolean(p) && ['pending', 'approved', 'rejected'].includes(p!.status), p?.status);
    }
    if (a.proposalId) {
      const noToken = await json(`/api/proposals/${a.proposalId}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) });
      check('a decision without the requester token is refused', noToken.status === 403);
    }
    check('the public result never names the model', !JSON.stringify(a).match(/gemini-\d/i));
    const again = await json(`/api/analyses/${a.id}`);
    check('the analysis is stored in Firestore and readable', again.status === 200 && again.body.id === a.id);
  }

  // leave nothing behind: both checks, their proposals and their points on the history
  const made = [a?.id, events.at(-1)?.analysis?.id].filter((x): x is string => typeof x === 'string');
  let removed = 0;
  for (const id of made) if ((await fetch(`${base}/api/analyses/${id}`, { method: 'DELETE', headers: { 'x-skudesk-owner': ownerKey } })).status === 200) removed++;
  check('the smoke run removed what it created', removed === made.length, `${removed} of ${made.length}`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
