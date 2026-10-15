// Edge front door for skudesk.lol. The app itself runs on Google Cloud Run; this Worker only forwards requests to it.
const ORIGIN = 'https://skudesk-ij5vrivnta-as.a.run.app';

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.hostname !== 'skudesk.lol') {
      url.hostname = 'skudesk.lol';
      return Response.redirect(url.toString(), 301);
    }
    const headers = new Headers(req.headers);
    headers.delete('host');
    const ip = req.headers.get('cf-connecting-ip');
    if (ip) headers.set('x-forwarded-for', ip);
    return fetch(new Request(new URL(url.pathname + url.search, ORIGIN), { method: req.method, headers, body: req.body, redirect: 'manual' }));
  },
};
