import { imageUrlOk } from './security.ts';

// Product pictures come from a short list of Google and eBay hosts. The same rule serves the browser proxy and the photo check.
export interface Picture { type: string; body: Buffer }

export async function fetchPicture(raw: string, fetchImpl: typeof fetch = fetch): Promise<Picture | null> {
  const target = imageUrlOk(raw);
  if (!target) return null;
  const up = await fetchImpl(target, { signal: AbortSignal.timeout(5000), redirect: 'error' }).catch(() => null);
  const type = up?.headers.get('content-type') ?? '';
  if (!up?.ok || !/^image\/(png|jpe?g|webp|gif)/.test(type)) return null;
  const body = Buffer.from(await up.arrayBuffer());
  return body.length > 1_500_000 ? null : { type: type.split(';')[0], body };
}
