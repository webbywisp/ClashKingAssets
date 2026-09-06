import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

// Unit-test entrypoint orchestration with explicit contexts. This does not emulate
// the Cloudflare distributed cache or claim live purge propagation coverage.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return {
      url: 'data:text/javascript,export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});
const { default: Gateway, AssetOrigin } = await import('../src/index.ts');
hooks.deregister();

test('gateway normalizes requests, strips incoming headers, and handles conditional hits', async () => {
  const forwarded: Request[] = [];
  const gateway = new Gateway({ exports: { AssetOrigin: {
    async fetch(request: Request) {
      forwarded.push(request);
      return new Response('{}', { headers: {
        ETag: '"new"', 'Last-Modified': 'Fri, 04 Sep 2026 00:00:00 GMT',
        'Content-Type': 'application/json', 'Content-Length': '2',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Cloudflare-CDN-Cache-Control': 'public, max-age=60',
      } });
    },
  } } }, {});
  const result = await gateway.fetch(new Request('https://assets.clashk.ing/static_data.json?v=123', { headers: {
    'If-None-Match': '"new"', 'Authorization': 'Bearer random', 'Cookie': 'x=1',
    'Cloudflare-Workers-Version-Key': 'unlimited', 'X-Forwarded-Host': 'random', 'Cache-Control': 'no-cache',
  } }));
  assert.equal(result.status, 304);
  assert.equal(forwarded[0].url, 'https://assets.internal/static_data.json');
  assert.equal([...forwarded[0].headers].length, 0);
  assert.equal((await gateway.fetch(new Request('https://assets.clashk.ing/a.avif?size=999'))).status, 400);
  assert.equal(forwarded.length, 1);
  const head = await gateway.fetch(new Request('https://assets.clashk.ing/static_data.json', { method: 'HEAD' }));
  assert.equal(await head.text(), '');
  assert.equal(forwarded[1].method, 'GET');
});

test('purge RPC uses AssetOrigin context, never the gateway cache or a zone API', async () => {
  const calls: unknown[] = [];
  const origin = new AssetOrigin({ cache: { async purge(options: unknown) {
    calls.push(options); return { success: true, errors: [] };
  } } }, {});
  const gateway = new Gateway({
    cache: { purge() { throw Error('wrong entrypoint'); } },
    exports: { AssetOrigin: origin },
  }, { PURGE_TOKEN: 'x'.repeat(32), PURGE_ENABLED: 'true' });
  const result = await gateway.fetch(new Request('https://assets.clashk.ing/__admin/purge', {
    method: 'POST', headers: { Authorization: `Bearer ${'x'.repeat(32)}` },
  }));
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ purgeEverything: true }]);
});

test('CORS preflight and unsupported methods never reach the image/cache entrypoint', async () => {
  const gateway = new Gateway({ exports: {} }, {});
  const preflight = await gateway.fetch(new Request('https://assets.clashk.ing/static_data.json', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
  assert.equal((await gateway.fetch(new Request('https://assets.clashk.ing/a.webp', { method: 'DELETE' }))).status, 405);
});
