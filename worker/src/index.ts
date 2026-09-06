import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  canonicalRequest, clientResponse, errorResponse, originalRange, parseAssetRequest,
  purgeRequest, PURGE_PATH, serveAsset,
} from './assets.ts';

interface GatewayEnv extends Omit<Cloudflare.Env, 'PURGE_ENABLED'> {
  PURGE_TOKEN?: string;
  PURGE_ENABLED: string;
}

// All cacheable responses belong to this entrypoint. RPC runs with its context,
// so tag purges clear this cache, including original and AVIF paths.
export class AssetOrigin extends WorkerEntrypoint<GatewayEnv> {
  async fetch(request: Request): Promise<Response> {
    try { return await serveAsset(request, this.env); }
    catch { return errorResponse(502, 'Asset read failed'); }
  }
  async purgeTags(tags: string[]) {
    if (!this.ctx.cache) throw new Error('Workers Cache API is unavailable');
    return this.ctx.cache.purge({ tags });
  }
}

export default class AssetsGateway extends WorkerEntrypoint<GatewayEnv> {
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === PURGE_PATH) {
        return purgeRequest(request, this.env.PURGE_TOKEN, this.env.PURGE_ENABLED,
          (tags) => this.ctx.exports.AssetOrigin.purgeTags(tags));
      }
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'If-None-Match, If-Modified-Since, Range, If-Range',
          'Access-Control-Max-Age': '86400', 'Cache-Control': 'no-store',
        } });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'GET or HEAD required');
      let asset;
      try { asset = parseAssetRequest(url); }
      catch { return errorResponse(400, 'Invalid asset path or size'); }
      const range = await originalRange(request, asset, this.env);
      if (range) return clientResponse(request, range);
      const response = await this.ctx.exports.AssetOrigin.fetch(canonicalRequest(asset));
      return clientResponse(request, response);
    } catch { return errorResponse(502, 'Asset service unavailable'); }
  }
}
