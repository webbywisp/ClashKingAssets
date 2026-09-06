import { staticImageStream } from './static-image.ts';

export const YEAR = 31_536_000;
export const PURGE_PATH = '/__admin/purge';
export const SIZES = new Set(['64', '128', '256', '512', '1024']);
export const SOURCE_EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg'] as const;
export interface AssetRequest { key: string; size?: number; path: string }
export interface AssetEnv { ASSETS: R2Bucket; IMAGES: ImagesBinding }

export function errorResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: {
    'Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain; charset=utf-8',
  } });
}

// Decode once and re-encode each segment: equivalent URL spellings share one key.
// Query parameters other than size retain legacy passthrough behavior but are discarded.
export function parseAssetRequest(url: URL): AssetRequest {
  const segments = url.pathname.slice(1).split('/').map(decodeURIComponent);
  if (segments.some(s => !s || s === '.' || s === '..' || /[\\/\x00-\x1f\x7f]/.test(s)) ||
      segments[0] === '__admin') throw new Error('Invalid asset path');
  const key = segments.join('/');
  const sizes = url.searchParams.getAll('size');
  if (sizes.length > 1 || (sizes.length === 1 && !SIZES.has(sizes[0]))) {
    throw new Error('size must be one of 64, 128, 256, 512, 1024');
  }
  // Original paths always return originals, even when a legacy query is present.
  const size = key.endsWith('.avif') && sizes.length ? Number(sizes[0]) : undefined;
  return { key, size, path: '/' + segments.map(encodeURIComponent).join('/') +
    (size === undefined ? '' : `?size=${size}`) };
}

export function canonicalRequest(asset: AssetRequest): Request {
  // Construct fresh headers: cookies, validators, cache bypasses, Vary inputs,
  // method overrides and version-key headers must never fragment the inner cache.
  return new Request(`https://assets.internal${asset.path}`, { method: 'GET' });
}

export function transformOptions(size?: number): ImageTransform {
  return size === undefined ? {} : { width: size, height: size, fit: 'scale-down' };
}

const TYPES: Record<string, string> = {
  png: 'image/png', webp: 'image/webp', avif: 'image/avif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', json: 'application/json', glb: 'model/gltf-binary',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', ogg: 'audio/ogg',
  pdf: 'application/pdf', html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', eps: 'application/postscript', ai: 'application/postscript',
};

function assetHeaders(object: R2Object, key: string, transformed: boolean, size?: number): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  headers.set('Content-Type', TYPES[ext] ?? headers.get('Content-Type') ?? 'application/octet-stream');
  headers.set('Last-Modified', object.uploaded.toUTCString());
  // A weak validator identifies this recipe/source version without claiming byte identity.
  headers.set('ETag', transformed ? `W/"${object.etag}-avif-q80-v1-${size ?? 'full'}"` : object.httpEtag);
  headers.set('Cache-Control', headers.get('Content-Type')!.startsWith('image/') ?
    `public, max-age=${YEAR}, immutable` : 'public, max-age=0, must-revalidate');
  // Mutable game metadata must refresh without any release-triggered purge.
  headers.set('Cloudflare-CDN-Cache-Control', `public, max-age=${ext === 'json' ? 60 : YEAR}`);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', 'ETag, Last-Modified, Content-Length, Content-Range, Accept-Ranges');
  headers.set('X-Content-Type-Options', 'nosniff');
  // Never inherit a stale encoding or Vary from source object metadata for a conversion.
  if (transformed) {
    headers.delete('Content-Encoding');
    headers.delete('Content-Length');
    headers.set('Content-Type', 'image/avif');
  } else {
    headers.set('Content-Length', String(object.size));
    headers.set('Accept-Ranges', 'bytes');
  }
  return headers;
}

export async function serveAsset(request: Request, env: AssetEnv): Promise<Response> {
  let asset: AssetRequest;
  try { asset = parseAssetRequest(new URL(request.url)); }
  catch { return errorResponse(400, 'Invalid asset request'); }
  const exact = await env.ASSETS.get(asset.key);
  let source = exact;
  let transformed = asset.key.endsWith('.avif') && asset.size !== undefined;
  if (!source && asset.key.endsWith('.avif')) {
    // Runtime collision check also protects bucket-only assets absent from the checkout.
    const stem = asset.key.slice(0, -5);
    const candidates = (await Promise.all(SOURCE_EXTENSIONS.map(ext => env.ASSETS.head(stem + ext))))
      .filter((object): object is R2Object => object !== null);
    if (candidates.length > 1) return errorResponse(409, 'Ambiguous image source');
    if (candidates.length === 1) source = await env.ASSETS.get(candidates[0].key);
    transformed = true;
  }
  if (!source) return errorResponse(404, 'Asset not found');
  const headers = assetHeaders(source, asset.key, transformed, asset.size);
  if (!transformed) return new Response(source.body, { headers });
  if (source.size > 20 * 1024 * 1024) {
    await source.body.cancel();
    return errorResponse(413, 'Image exceeds transformation limit');
  }
  try {
    const staticBody = await staticImageStream(source.body);
    if (!staticBody) return errorResponse(422, 'Animated image: request the original URL');
    let image = env.IMAGES.input(staticBody);
    if (asset.size !== undefined) image = image.transform(transformOptions(asset.size));
    const output = await image.output({ format: 'image/avif', quality: 80 });
    const encoded = output.response();
    if (encoded.headers.get('Content-Type')?.split(';')[0].trim() !== 'image/avif') {
      await encoded.body?.cancel();
      return errorResponse(502, 'Encoder did not produce AVIF; request the original or a smaller size');
    }
    return new Response(encoded.body, { headers });
  } catch {
    return errorResponse(502, 'Image transformation failed');
  }
}

export function notModified(request: Request, headers: Headers): boolean {
  const etag = headers.get('ETag');
  const condition = request.headers.get('If-None-Match');
  if (condition !== null) {
    // Commas may occur inside opaque tags. Match complete quoted tokens.
    const tags = condition.match(/(?:W\/)?"[^"\r\n]*"|\*/g) ?? [];
    return tags.some(tag => tag === '*' || (etag !== null && tag.replace(/^W\//, '') === etag.replace(/^W\//, '')));
  }
  const since = request.headers.get('If-Modified-Since');
  const modified = headers.get('Last-Modified');
  return since !== null && modified !== null && Date.parse(modified) <= Date.parse(since);
}

export async function clientResponse(request: Request, response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  // The gateway itself is explicitly uncached; this header is only for AssetOrigin.
  headers.delete('Cloudflare-CDN-Cache-Control');
  if (response.status === 200 && notModified(request, headers)) {
    await response.body?.cancel();
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') {
    await response.body?.cancel();
    return new Response(null, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
}

export interface PurgeResult { success: boolean }
export async function purgeRequest(
  request: Request, secret: string | undefined, enabled: string | undefined,
  purge: () => Promise<PurgeResult>,
): Promise<Response> {
  if (request.method !== 'POST') return errorResponse(405, 'POST required');
  if (enabled !== 'true' || !secret || secret.length < 32) return errorResponse(503, 'Purge is not configured');
  const supplied = request.headers.get('Authorization') ?? '';
  const encoder = new TextEncoder();
  const expectedHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`Bearer ${secret}`)));
  const actualHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(supplied)));
  let difference = 0;
  for (let i = 0; i < expectedHash.length; i++) difference |= expectedHash[i] ^ actualHash[i];
  if (difference !== 0) return errorResponse(401, 'Unauthorized');
  if (new URL(request.url).search || request.body !== null) return errorResponse(400, 'No query or body allowed');
  try {
    const result = await purge();
    if (!result.success) return errorResponse(502, 'Worker cache purge rejected; retry after backoff');
    return new Response(JSON.stringify({ success: true, scope: 'AssetOrigin' }), { headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Cloudflare-CDN-Cache-Control': 'no-store',
    } });
  } catch { return errorResponse(502, 'Worker cache purge failed; retry after backoff'); }
}

// Original-file byte ranges bypass the response cache; useful for audio, PDFs and GLBs.
export async function originalRange(request: Request, asset: AssetRequest, env: AssetEnv): Promise<Response | null> {
  if (request.method !== 'GET' || asset.key.endsWith('.avif')) return null;
  const value = request.headers.get('Range');
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  // Ignore malformed/multiple ranges as permitted by HTTP, returning the full representation.
  if (!match || (!match[1] && !match[2])) return null;
  const object = await env.ASSETS.head(asset.key);
  if (!object) return errorResponse(404, 'Asset not found');
  const headers = assetHeaders(object, asset.key, false);
  if (notModified(request, headers)) return new Response(null, { status: 304, headers });
  const ifRange = request.headers.get('If-Range');
  if (ifRange && ifRange !== object.httpEtag &&
      !(Date.parse(ifRange) >= Date.parse(object.uploaded.toUTCString()))) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, object.size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), object.size - 1) : object.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= object.size) {
    const response = errorResponse(416, 'Range not satisfiable');
    response.headers.set('Content-Range', `bytes */${object.size}`);
    return response;
  }
  const body = await env.ASSETS.get(asset.key, {
    range: { offset: start, length: end - start + 1 }, onlyIf: { etagMatches: object.etag },
  });
  // A concurrent overwrite must not produce old headers with a new body's range.
  if (!body || !('body' in body)) return null;
  headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.delete('Cloudflare-CDN-Cache-Control');
  return new Response(body.body, { status: 206, headers });
}
