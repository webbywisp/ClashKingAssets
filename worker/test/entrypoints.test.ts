import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

// Unit-test public-entrypoint orchestration with an explicit context. This does
// not emulate Cloudflare's distributed lower and upper cache tiers.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return {
      url: 'data:text/javascript,export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});
const { default: AssetsWorker } = await import('../src/index.ts');
hooks.deregister();

function envWithJson() {
  const gets: string[] = [];
  const data = '{}';
  return {
    gets,
    env: {
      ASSETS: {
        async get(key: string) {
          gets.push(key);
          if (key !== 'static_data.json') return null;
          return {
            key, size: data.length, etag: 'new', httpEtag: '"new"',
            uploaded: new Date('2026-09-04T00:00:00Z'), body: new Response(data).body!,
            writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'application/json'); },
          };
        },
        async head() { return null; },
      },
      IMAGES: {},
      PURGE_ENABLED: 'true',
    },
  };
}

test('the public entrypoint serves assets directly and handles conditional misses', async () => {
  const { env, gets } = envWithJson();
  const worker = new AssetsWorker({ cache: {} }, env);
  const result = await worker.fetch(new Request('https://assets.clashk.ing/static_data.json?ignored=123', {
    headers: { 'If-None-Match': '"new"' },
  }));
  assert.equal(result.status, 304);
  assert.deepEqual(gets, ['static_data.json']);
  assert.equal(result.headers.get('Cloudflare-CDN-Cache-Control'), 'public, max-age=31536000');
  assert.equal((await worker.fetch(new Request('https://assets.clashk.ing/a.avif?size=999'))).status, 400);
  const head = await worker.fetch(new Request('https://assets.clashk.ing/static_data.json', { method: 'HEAD' }));
  assert.equal(await head.text(), '');
});

test('the purge endpoint clears the public entrypoint cache', async () => {
  const calls: unknown[] = [];
  const worker = new AssetsWorker({ cache: { async purge(options: unknown) {
    calls.push(options); return { success: true, errors: [] };
  } } }, { PURGE_TOKEN: 'x'.repeat(32), PURGE_ENABLED: 'true' });
  const result = await worker.fetch(new Request('https://assets.clashk.ing/__admin/purge', {
    method: 'POST', headers: { Authorization: `Bearer ${'x'.repeat(32)}` },
    body: JSON.stringify({ tags: ['asset-' + 'a'.repeat(64)] }),
  }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { success: true, scope: 'Assets' });
  assert.deepEqual(calls, [{ tags: ['asset-' + 'a'.repeat(64)] }]);
});

test('CORS preflight and unsupported methods do not read assets', async () => {
  const worker = new AssetsWorker({ cache: {} }, {});
  const preflight = await worker.fetch(new Request('https://assets.clashk.ing/static_data.json', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
  assert.equal((await worker.fetch(new Request('https://assets.clashk.ing/a.webp', { method: 'DELETE' }))).status, 405);
});
