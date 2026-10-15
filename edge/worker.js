// Edge front door for skudesk.lol. The app itself runs on Google Cloud Run; this Worker forwards requests to it.
// It proves itself to the app with a shared secret so the app can trust the visitor address it reports.
const ORIGIN = 'https://skudesk-ij5vrivnta-as.a.run.app';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.hostname !== 'skudesk.lol') {
      url.hostname = 'skudesk.lol';
      return Response.redirect(url.toString(), 301);
    }
    const headers = new Headers(req.headers);
    headers.delete('host');
    // Never forward these from the visitor; set them ourselves.
    headers.delete('x-skudesk-edge');
    headers.delete('x-skudesk-client-ip');
    if (env.EDGE_SECRET) {
      headers.set('x-skudesk-edge', env.EDGE_SECRET);
      headers.set('x-skudesk-client-ip', req.headers.get('cf-connecting-ip') ?? '');
    }
    const res = await fetch(new Request(new URL(url.pathname + url.search, ORIGIN), { method: req.method, headers, body: req.body, redirect: 'manual' }));
    const out = new Response(res.body, res);
    // Pages and API answers must always revalidate; an edge default must never pin a stale copy.
    const type = out.headers.get('content-type') ?? '';
    if (/text\/html|json/.test(type)) out.headers.set('cache-control', out.headers.get('cache-control') ?? 'no-cache');
    return out;
  },
};
