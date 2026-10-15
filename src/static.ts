import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SECURITY_HEADERS } from './security.ts';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', woff2: 'font/woff2', ico: 'image/x-icon',
  json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', webmanifest: 'application/manifest+json',
};

interface Entry { type: string; body: Buffer; etag: string; cache: string }
export interface Site { files: Map<string, Entry>; notFound?: Entry }

// Loads a built site once at start-up. Hashed build assets are immutable; everything else is revalidated with an ETag,
// so a stale copy can never outlive a deploy (a shared edge cache once pinned an old stylesheet for hours).
export function loadSite(dir: string): Site {
  const files = new Map<string, Entry>();
  if (!existsSync(dir)) return { files };
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) { walk(full, `${prefix}${name}/`); continue; }
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      if (!TYPES[ext]) continue;
      const body = readFileSync(full);
      const path = `/${prefix}${name}`;
      const cache = path.startsWith('/_astro/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      files.set(path, { type: TYPES[ext], body, etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 20)}"`, cache });
    }
  };
  walk(dir, '');
  for (const [path, e] of [...files]) if (path.endsWith('/index.html')) files.set(path.slice(0, -'index.html'.length), e);
  return { files, notFound: files.get('/404.html') };
}

// Returns true when the request was answered.
export function serveStatic(site: Site, req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let entry = site.files.get(path);
  if (!entry && !path.endsWith('/') && site.files.has(`${path}/`)) {
    res.writeHead(301, { location: `${path}/`, ...SECURITY_HEADERS });
    res.end();
    return true;
  }
  let status = 200;
  if (!entry) {
    if (path.startsWith('/api/') || !site.notFound) return false;
    entry = site.notFound;
    status = 404;
  }
  if (status === 200 && req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { etag: entry.etag, 'cache-control': entry.cache, ...SECURITY_HEADERS });
    res.end();
    return true;
  }
  res.writeHead(status, { 'content-type': entry.type, 'cache-control': status === 404 ? 'no-store' : entry.cache, etag: entry.etag, ...SECURITY_HEADERS });
  res.end(req.method === 'HEAD' ? undefined : entry.body);
  return true;
}
