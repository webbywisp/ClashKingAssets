import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  canonicalRequest, clientResponse, notModified, originalRange, parseAssetRequest,
  purgeRequest, serveAsset, SIZES, transformOptions, YEAR, assetCacheTag,
} from '../src/assets.ts';

test('version queries no longer partition the cache', () => {
  const sha = 'a'.repeat(64);
  for (const path of ['item.webp', 'item.avif?size=256']) {
    const separator = path.includes('?') ? '&' : '?';
    const asset = parseAssetRequest(new URL(`https://assets.clashk.ing/${path}${separator}v=${sha}`));
    assert.equal(canonicalRequest(asset).url, `https://assets.internal/${path}`);
  }
  assert.equal(parseAssetRequest(new URL('https://assets.clashk.ing/item.webp?v=random')).path, '/item.webp');
});

test('all image sizes and originals share only their family cache tag', async () => {
  const { env } = fixture({ 'icons/a.webp': 'image' });
  const original = await serveAsset(req('/icons/a.webp'), env);
  const sized = await serveAsset(req('/icons/a.avif?size=256'), env);
  assert.equal(original.headers.get('Cache-Tag'), sized.headers.get('Cache-Tag'));
  assert.equal(original.headers.get('Cache-Tag'), await assetCacheTag('icons/a.png'));
  assert.notEqual(await assetCacheTag('icons/a.webp'), await assetCacheTag('icons/A.webp'));
});

function fixture(files: Record<string, string>) {
  const calls = { get: [] as string[], head: [] as string[], transform: [] as unknown[], output: [] as unknown[] };
  const object = (key: string, data: string) => ({
    key, size: new TextEncoder().encode(data).length, etag: 'abc', httpEtag: '"abc"',
    uploaded: new Date('2026-09-01T12:00:00.567Z'),
    customMetadata: { sha256: 'a'.repeat(64) },
    writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'application/octet-stream'); },
    body: new Response(data).body!,
  });
  const env = {
    ASSETS: {
      async get(key: string, options?: { range: { offset: number; length: number } }) {
        calls.get.push(key);
        if (!(key in files)) return null;
        const result = object(key, files[key]);
        if (options?.range) result.body = new Response(files[key].slice(options.range.offset, options.range.offset + options.range.length)).body!;
        return result;
      },
      async head(key: string) { calls.head.push(key); return key in files ? object(key, files[key]) : null; },
    },
    IMAGES: { input(stream: ReadableStream) {
      const image = {
        transform(options: unknown) { calls.transform.push(options); return image; },
        async output(options: unknown) {
          calls.output.push(options); await new Response(stream).text();
          return { response: () => new Response('avif-bytes', { headers: { 'Content-Type': 'image/avif' } }) };
        },
      };
      return image;
    } },
  };
  return { env, calls };
}
const req = (path: string, init?: RequestInit) => new Request('https://assets.clashk.ing' + path, init);

test('canonical keys distinguish every size and format and discard arbitrary cache busters', () => {
  const keys = new Set<string>();
  for (const ext of ['avif', 'webp', 'png', 'json']) {
    for (const size of [undefined, ...SIZES]) {
      const path = `/troops/barbarian.${ext}` + (size ? `?size=${size}` : '');
      const parsed = parseAssetRequest(new URL(req(path).url));
      const inner = canonicalRequest(parsed);
      keys.add(inner.url);
      assert.equal(inner.method, 'GET');
      assert.equal([...inner.headers].length, 0);
      const dirty = parseAssetRequest(new URL(req(path + (size ? '&' : '?') + 'url=https://evil.test/x&quality=1').url));
      assert.equal(canonicalRequest(dirty).url, inner.url);
    }
  }
  assert.equal(keys.size, 9); // Six AVIF recipes plus three unmodified originals.
  assert.equal(parseAssetRequest(new URL(req('/troops/%62arbarian.avif?%73ize=128').url)).path,
    '/troops/barbarian.avif?size=128');
});

test('rejects invalid sizes, duplicate sizes and unsafe decoded paths', () => {
  for (const query of ['size=1', 'size=4096', 'size=', 'size=0128', 'size=128&size=128', 'size=1e2']) {
    assert.throws(() => parseAssetRequest(new URL(req('/a.avif?' + query).url)));
  }
  for (const path of ['/a%2fb.avif', '/a%5cb.webp', '/a%00.webp', '//a.webp', '/%ZZ', '/__admin/purge']) {
    assert.throws(() => parseAssetRequest(new URL(req(path).url)));
  }
});

test('AVIF maps to private bucket source, uses square scale-down bounds and a fixed recipe', async () => {
  for (const size of SIZES) {
    const { env, calls } = fixture({ 'troops/barbarian.webp': 'webp' });
    const response = await serveAsset(req(`/troops/barbarian.avif?size=${size}`), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'avif-bytes');
    assert.deepEqual(calls.transform, [{ width: Number(size), height: Number(size), fit: 'scale-down' }]);
    assert.deepEqual(calls.output, [{ format: 'image/avif', quality: 80 }]);
    assert.equal(response.headers.get('Content-Type'), 'image/avif');
    assert.equal(response.headers.get('X-Asset-Source-Sha'), 'a'.repeat(64));
    assert.match(response.headers.get('Access-Control-Expose-Headers')!, /X-Asset-Source-Sha/);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  }
  assert.deepEqual(transformOptions(), {});
  const { env, calls } = fixture({ 'a.png': 'png' });
  await serveAsset(req('/a.avif'), env);
  assert.deepEqual(calls.transform, []);
});

test('real AVIF wins over other sources, unchanged without size and resized only on request', async () => {
  const { env, calls } = fixture({ 'a.avif': 'original-avif', 'a.webp': 'webp', 'a.png': 'png' });
  assert.equal(await (await serveAsset(req('/a.avif'), env)).text(), 'original-avif');
  assert.equal(calls.output.length, 0);
  assert.equal(calls.head.length, 0);
  assert.equal(await (await serveAsset(req('/a.avif?size=64'), env)).text(), 'avif-bytes');
  assert.equal(calls.head.length, 0);
});

test('collisions, missing sources and unsupported files never transform or cache failures', async () => {
  for (const [files, path, status] of [
    [{ 'a.webp': 'w', 'a.png': 'p' }, '/a.avif', 409],
    [{ 'a.svg': 's' }, '/a.avif', 404],
    [{}, '/missing.webp', 404],
  ] as const) {
    const { env, calls } = fixture(files);
    const response = await serveAsset(req(path), env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(calls.output.length, 0);
  }
});

test('original image, JSON, font and other asset consumers receive original bytes and MIME', async () => {
  for (const [key, type] of Object.entries({
    'a.webp': 'image/webp', 'a.png': 'image/png', 'a.json': 'application/json', 'a.woff2': 'font/woff2',
    'a.ogg': 'audio/ogg', 'a.glb': 'model/gltf-binary', 'a.unknown': 'application/octet-stream',
  })) {
    const { env, calls } = fixture({ [key]: 'original' });
    const response = await serveAsset(req('/' + key + '?size=128'), env);
    assert.equal(await response.text(), 'original');
    assert.equal(response.headers.get('Content-Type'), type);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Last-Modified'), 'Tue, 01 Sep 2026 12:00:00 GMT');
    assert.equal(calls.output.length, 0);
  }
});

test('mutable JSON has edge freshness, client revalidation, weak/list ETags, HEAD and 304', async () => {
  const { env } = fixture({ 'static_data.json': '{"new":true}' });
  const response = () => serveAsset(req('/static_data.json'), env);
  const initial = await response();
  assert.equal(initial.headers.get('Cloudflare-CDN-Cache-Control'), 'public, max-age=60');
  assert.equal(initial.headers.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  for (const condition of ['"abc"', 'W/"abc"', '"other", W/"abc"', '*']) {
    const result = await clientResponse(req('/static_data.json', { headers: { 'If-None-Match': condition } }), await response());
    assert.equal(result.status, 304);
    assert.equal(await result.text(), '');
    assert.equal(result.headers.get('Content-Length'), null);
    assert.equal(result.headers.get('ETag'), '"abc"');
  }
  const head = await clientResponse(req('/static_data.json', { method: 'HEAD' }), await response());
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('Content-Length'), '12');
  assert.equal(head.headers.get('Cloudflare-CDN-Cache-Control'), null);
  const headers = initial.headers;
  assert.equal(notModified(req('/', { headers: { 'If-Modified-Since': headers.get('Last-Modified')! } }), headers), true);
  assert.equal(notModified(req('/', { headers: { 'If-None-Match': '"old"', 'If-Modified-Since': 'Wed, 01 Sep 2027 12:00:00 GMT' } }), headers), false);
  assert.equal(notModified(req('/', { headers: { 'If-Modified-Since': 'invalid' } }), headers), false);
});

test('original byte ranges support audio and do not fragment the inner cache', async () => {
  const { env } = fixture({ 'music.ogg': '0123456789' });
  const asset = parseAssetRequest(new URL(req('/music.ogg').url));
  const response = await originalRange(req('/music.ogg', { headers: { Range: 'bytes=2-5' } }), asset, env);
  assert.equal(response!.status, 206);
  assert.equal(await response!.text(), '2345');
  assert.equal(response!.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.equal((await originalRange(req('/music.ogg', { headers: { Range: 'bytes=99-' } }), asset, env))!.status, 416);
  assert.equal(await originalRange(req('/music.ogg', { headers: { Range: 'bytes=0-1', 'If-Range': '"old"' } }), asset, env), null);
});

test('purge requires POST, configured strong secret, auth, bounded tags and exact scope', async () => {
  let count = 0;
  const purge = async () => { count++; return { success: true }; };
  const secret = 'a'.repeat(32);
  const authorized = { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ tags: ['asset-' + 'a'.repeat(64)] }) };
  const call = (request: Request, token = secret, enabled = 'true') => purgeRequest(request, token, enabled, purge);
  assert.equal((await call(req('/__admin/purge'))).status, 405);
  assert.equal((await call(req('/__admin/purge', { method: 'POST' }))).status, 401);
  assert.equal((await call(req('/__admin/purge', authorized), secret, 'false')).status, 503);
  assert.equal((await call(req('/__admin/purge', authorized), 'short')).status, 503);
  assert.equal((await call(req('/__admin/purge?scope=other', authorized))).status, 400);
  assert.equal((await call(req('/__admin/purge', { ...authorized, body: '{}' }))).status, 400);
  assert.equal((await call(req('/__admin/purge', { ...authorized, body: JSON.stringify({ purgeEverything: true }) }))).status, 400);
  assert.equal((await call(req('/__admin/purge', { ...authorized, body: 'x'.repeat(8001) }))).status, 413);
  assert.equal(count, 0);
  const response = await call(req('/__admin/purge', authorized));
  assert.deepEqual(await response.json(), { success: true, scope: 'AssetOrigin' });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(count, 1);
  assert.equal((await purgeRequest(req('/__admin/purge', authorized), secret, 'true', async () => ({ success: false }))).status, 502);
  assert.equal((await purgeRequest(req('/__admin/purge', authorized), secret, 'true', async () => { throw Error('secret'); })).status, 502);
});

test('wrangler enables cache only for the asset entrypoint and keeps production cutover manual', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.exports.default.cache.enabled, false);
  assert.equal(config.exports.AssetOrigin.cache.enabled, true);
  assert.equal(config.cache.cross_version_cache, false);
  assert.equal(config.routes, undefined);
  assert.equal(config.workers_dev, false);
  assert.equal(config.vars.PURGE_ENABLED, 'false');
});


test('encoder errors and non-AVIF fallbacks are never mislabeled or cached', async () => {
  for (const fail of [false, true]) {
    const { env } = fixture({ 'a.png': 'source' });
    env.IMAGES.input = () => ({ async output() {
      if (fail) throw Error('unsupported image');
      return { response: () => new Response('webp', { headers: { 'Content-Type': 'image/webp' } }) };
    } });
    const response = await serveAsset(req('/a.avif'), env);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  }
});
