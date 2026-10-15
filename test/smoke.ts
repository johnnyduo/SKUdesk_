// Smoke test against a DEPLOYED SKUdesk: real Cloud Run, real Firestore, real Gemini, real SerpApi.
// Usage: npm run smoke -- https://your-service-url [query]
// It spends at most one search (none if the query was already searched in the last 12 hours).
const base = (process.argv[2] ?? '').replace(/\/$/, '');
const query = process.argv[3] ?? 'LEGO 10294 Titanic';
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
check('UI page served with CSP', page.status === 200 && html.includes('SKUdesk') && Boolean(page.headers.get('content-security-policy')));

const status = await json('/api/status');
check('status reports Firestore and Gemini', status.status === 200 && String(status.body.store).startsWith('firestore:') && Boolean(status.body.model), `${status.body.store}, ${status.body.model}`);

const bad = await json('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '<script>', market: 'us' }) });
check('rejects a malformed query', bad.status === 400);

const scan = await json('/api/jobs/scan', { method: 'POST' });
check('scan endpoint refuses callers without the secret', scan.status === 401);

const res = await json('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, market: 'us' }) });
const a = res.body;
check('analysis completes', res.status === 200 && typeof a.headline === 'string', res.status === 200 ? a.headline : String(a.error));
if (res.status === 200) {
  check('every listing was put through the Identity Engine', a.gate.considered > 0 && a.gate.considered === a.gate.identical + a.gate.different + a.gate.uncertain, JSON.stringify(a.gate));
  check('money is integer cents', [a.buy?.landedCents, a.sell?.listAtCents].filter((v) => v !== undefined && v !== null).every(Number.isInteger));
  check('a buy always files a pending proposal, never a purchase', a.buy ? Boolean(a.proposalId) : a.proposalId === null);
  if (a.proposalId) {
    const list = await json('/api/proposals');
    const p = (list.body as unknown as { id: string; status: string }[]).find((x) => x.id === a.proposalId);
    check('the proposal is stored and not yet approved', Boolean(p) && ['pending', 'approved', 'rejected'].includes(p!.status), p?.status);
  }
  const again = await json(`/api/analyses/${a.id}`);
  check('the analysis is stored in Firestore and readable', again.status === 200 && again.body.id === a.id);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
