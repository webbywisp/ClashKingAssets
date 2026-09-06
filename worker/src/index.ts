import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  clientResponse, errorResponse, purgeRequest, PURGE_PATH, serveAsset,
} from './assets.ts';

interface AssetsEnv extends Omit<Cloudflare.Env, 'PURGE_ENABLED'> {
  PURGE_TOKEN?: string;
  PURGE_ENABLED: string;
}

// Workers Cache checks its lower and upper tiers before this entrypoint runs.
// A warm public request therefore executes no Worker code and makes no loopback call.
export default class AssetsWorker extends WorkerEntrypoint<AssetsEnv> {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === PURGE_PATH) {
        return purgeRequest(request, this.env.PURGE_TOKEN, this.env.PURGE_ENABLED,
          (tags) => {
            if (!this.ctx.cache) throw new Error('Workers Cache API is unavailable');
            return this.ctx.cache.purge({ tags });
          });
      }
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'If-None-Match, If-Modified-Since, Range, If-Range',
          'Access-Control-Max-Age': '86400', 'Cache-Control': 'no-store',
        } });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'GET or HEAD required');
      return clientResponse(request, await serveAsset(request, this.env));
    } catch { return errorResponse(502, 'Asset service unavailable'); }
  }
}
