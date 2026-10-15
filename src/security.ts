import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

export function safeEq(given: string | undefined, want: string | undefined): boolean {
  if (!given || !want) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const header = (req: IncomingMessage, name: string): string => String(req.headers[name] ?? '');

// The caller's IP. Behind our own edge Worker (which proves itself with a shared secret) we trust the address it
// reports. Otherwise we take the LAST x-forwarded-for entry, the one Google's front end appended; earlier entries are
// client-supplied and can be forged to dodge rate limits.
export function clientIp(req: IncomingMessage, edgeSecret: string): string {
  if (edgeSecret && safeEq(header(req, 'x-skudesk-edge'), edgeSecret)) {
    const fromEdge = header(req, 'x-skudesk-client-ip').trim();
    if (fromEdge) return fromEdge;
  }
  const chain = header(req, 'x-forwarded-for').split(',').map((s) => s.trim()).filter(Boolean);
  return chain.at(-1) ?? req.socket.remoteAddress ?? 'unknown';
}

export const isOwner = (req: IncomingMessage, ownerKey: string): boolean => safeEq(header(req, 'x-skudesk-owner'), ownerKey);

// Sliding-window limiter. hit() records the call and says whether the caller is now over the limit.
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  hit(key: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return recent.length > this.max;
  }
}

// Only these hosts may be fetched by the image proxy, so it cannot be turned into an open proxy.
export const IMAGE_HOSTS = /^(encrypted-tbn[0-3]\.gstatic\.com|[a-z0-9-]+\.googleusercontent\.com|serpapi\.com|i\.ebayimg\.com)$/;

export function imageUrlOk(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !IMAGE_HOSTS.test(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}
