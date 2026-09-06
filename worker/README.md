# Assets delivery Worker

Implementation only: no Worker, bucket, DNS, public-access setting or release has
been changed. The configuration intentionally has no public route and binds the existing
`clashking-assets` bucket. Deploy only after the cutover checklist below is approved.

## Request contract

The public origin remains `https://assets.clashk.ing`. R2 keys remain paths relative
to `assets/`, exactly as uploaded by `build.py`. No `/img/` prefix or public R2 origin
is introduced. The entire bound bucket must contain public assets only.

| Request | Response |
| --- | --- |
| `/troops/barbarian.webp` | Original WebP, unchanged bytes |
| `/troops/barbarian.png` | Original PNG if that exact object exists |
| `/troops/barbarian.avif` | Exact AVIF if present; otherwise convert the corresponding raster source at original dimensions |
| `/troops/barbarian.avif?size=128` | AVIF contained within 128 × 128 physical pixels, maintaining aspect ratio and never upscaling |
| `/static_data.json`, `/translations.json` | Original JSON with ETag and Last-Modified |
| Any other existing file | Original bytes and content type; fonts, audio, models and viewer files remain usable |

The example stem is illustrative; request actual paths from the existing catalog.
Replace only the last extension of a known PNG/WebP/JPEG path. Only lowercase
`.avif` selects conversion. Allowed sizes are 64, 128, 256, 512 and 1024; omission
means original dimensions. The encoding recipe is fixed AVIF quality 80. A real AVIF
wins even if PNG/WebP siblings exist, and is resized only when size is supplied.

Missing AVIFs look for `.webp`, `.png`, `.jpg`, `.jpeg` siblings in that order;
exactly one must exist. Multiple candidates fail with an uncached 409 rather than
silently selecting different artwork. `check_image_sources.py` checks release
files, and the Worker also detects collisions in bucket-only objects. The initial
checkout has 2,983 raster sources, zero collisions and zero AVIF objects. There is
no runtime catalog or manifest dependency, and newly uploaded paths work without
a Worker deployment. SVG/GIF do not create synthetic AVIF aliases.

Unknown query parameters are ignored before cache lookup, preserving legacy
cache-buster URLs without creating extra variants. `size` must be valid and appear
at most once, even on originals; a valid size on an original path does not resize
it. Escaped path segments are normalized once; separators inside segments, control
characters and the reserved `__admin` namespace are rejected. Requests never fetch
an external URL. Arbitrary query parameters cannot alter quality, source or format.

Original files support GET, HEAD and conditional requests. Single byte ranges on
non-AVIF originals use private R2 reads outside the response cache, preserving
media seeking. Multiple/malformed ranges and ranges on AVIF are ignored, returning
the full representation. CORS permits public reads and exposes validators and
length/range headers; it does not expose purge credentials.

## Cache and freshness

`AssetsGateway` (default export) has caching disabled. It constructs a canonical,
header-free GET to `ctx.exports.AssetOrigin.fetch()`. **AssetOrigin owns the only
response cache**, with the new tiered Workers Cache enabled. It reads private R2
and streams bytes into the Images binding on a transformation miss. There is no
KV image cache, legacy Cache API, public-origin fetch, saved R2 variant or generated
AVIF committed to Git.

Before transforming a raster, the Worker inspects up to 64 KiB of container
headers and then streams the original bytes into Images. Animated WebP/APNG and
AVIF sequences return an uncached 422 so the app uses the original animation.
Unusually long unclassified headers also fall back instead of risking flattening.

The canonical path includes the output extension and, for AVIF, the single size
parameter. That gives at most six AVIF recipe keys per known stem. Requests do not
forward cookies, Authorization, user-controlled version keys, method overrides,
conditional headers or cache-bypass headers to AssetOrigin. GET/HEAD share a body
fill. Worker version isolation stays enabled; a deployment gets a fresh namespace.
Errors are never stored and there is no negative-cache invalidation dependency.

Image client freshness is `public, max-age=31536000, immutable`. JSON and other
non-image clients receive `public, max-age=0, must-revalidate`, while AssetOrigin
sets `Cloudflare-CDN-Cache-Control: public, max-age=31536000`. The gateway evaluates
If-None-Match (including weak tags, lists and wildcard), then If-Modified-Since,
against the cached metadata and returns 304 without a body when appropriate.
If-None-Match takes precedence. HEAD returns the same Last-Modified, ETag and
representation length without a body. R2 upload timestamps supply Last-Modified,
rounded to HTTP seconds, preserving the existing native HEAD comparison contract.
As with the existing service, two overwrites within one second need ETag to detect.

Cloudflare's current limits page lists a 1,200-pixel AVIF limit for remote/hosted
images and Enterprise-only AVIF input. The binding section separately lists a
20 MB input limit; it does not clearly exempt the binding from the format limits.
There are 34 current raster sources exceeding 1,200 pixels. The five thumbnail
sizes are within that bound, but original-dimension AVIF on these larger sources
and resizing existing AVIFs must be verified on the target account in staging.
The Worker never deliberately downsizes a no-size request or labels a WebP/JPEG
fallback as AVIF: an unsupported conversion returns an uncached 502, and clients
can use the original URL or a supported size. Exact AVIF passthrough requires no
Images decoding. Do not promise universal full-dimension AVIF until this account
capability is established.

No periodic image revalidation or extra runtime manifest is introduced. A TTL is a
freshness limit, not a storage guarantee; Cloudflare can evict an entry earlier.
Device copies may remain old after a rare overwrite, as accepted in the plan.

## Optional manual cache clearing

Asset releases do not purge the Worker cache, require purge credentials, or wait
for cache invalidation. Same-path overwrites may keep serving cached content; this
is an accepted rollout decision. It applies to JSON as well as images: client
revalidation does not bypass the Worker's cached representation.

The optional `POST /__admin/purge` operation and `worker_purge.py` helper remain
available for a future manual operation, disabled by default. Enabling them is
not a release or cutover requirement. If needed later, provision a server-only
`PURGE_TOKEN` of at least 32 characters and set `PURGE_ENABLED=true`. The helper
uses `ASSETS_WORKER_PURGE_URL` and `ASSETS_WORKER_PURGE_TOKEN` only when explicitly
run. Never put those credentials in the app. A zone purge does not clear the
AssetOrigin entrypoint cache. The helper makes two passes, 60 seconds apart;
in-flight fills can still repopulate stale content, so verify freshness after a
manual purge. No automatic cache-clearing guarantee is made.

## Configuration and local checks

The R2 `ASSETS` binding points to the existing `clashking-assets` bucket. Override
it with a separate fixture bucket for staging. Enable the Images `IMAGES` binding
in the correct account. Leave `PURGE_ENABLED=false` for this rollout.
No GitHub purge URL, token or required flag is needed. Existing R2 and optional
translation-KV configuration remain independent.

From `worker/`, using Node 24 or newer:

```sh
npm ci
npm test
npm run types
npm run typecheck
npm run check:layout
npm run build
```

`npm run build` is a local Wrangler dry run, not a deployment. In a restricted
checkout, set `WRANGLER_LOG_PATH=/tmp/assets-worker-wrangler.log` if needed.
From the repository root, run:

```sh
.venv/bin/python -m pytest -q test_worker_purge.py test_build.py test_translation_kv.py
.venv/bin/python -m ruff check build.py worker_purge.py check_image_sources.py test_worker_purge.py
```

Tests cover source mapping, size bounds/options, cache-key normalization, real AVIF
precedence, original and range handling, JSON conditions, authentication and
entrypoint scope, and the absence of release-triggered purges. Bindings and entrypoint contexts
are mocked; these tests do not establish live tiered-cache behavior, AVIF encoder
output, custom-domain readiness or purge propagation. No visual tests are used.

## Migration checklist — requires separate authorization

1. Inventory the current `assets.clashk.ing` DNS/R2 custom-domain association,
   bucket name, R2 public-access/CORS settings and legacy cache rules. Save rollback
   settings. Audit that the bound bucket contains only intended public assets;
   do not repurpose a mixed/private bucket. Compare bucket-only image stems for
   collisions as well as running the repository validator.
2. Confirm account support, Images plan/quota and Wrangler 4.129.0. Create an
   isolated staging configuration using a fixture R2 bucket and a temporary Worker
   hostname; do not change the production bucket or hostname. Leave manual purge disabled. Stage small PNG/WebP, real AVIF, JSON, font and audio fixtures.
3. Deploy staging only after approval. Use HTTP/code-level probes to compare
   original byte hashes and content types; inspect transformed dimensions and
   aspect ratio/no-upscale; request each size and format in alternating order and
   inspect cache status/logs. Different query garbage and headers must converge on
   the canonical inner key. Confirm gateway and AssetOrigin logs distinguish hits.
4. Verify cached JSON/image reads, conditional GET and HEAD behavior. Same-path
   overwrites are allowed to remain cached; automatic invalidation is out of scope.
5. Pause asset releases and other R2 writers for the production migration. Prepare
   the production Worker with the existing private R2 binding, and
   confirm readiness before detaching the existing R2 custom-domain association.
   Do not attempt simultaneous R2 and Worker ownership of `assets.clashk.ing`.
6. In the approved window, remove the old R2 domain association/DNS conflict and
   attach `assets.clashk.ing` as a Worker custom domain using the commented route
   shape in `wrangler.jsonc`. Keep the hostname and all object keys unchanged.
   Disable any remaining public R2 access only after private-binding reads work.
   No `r2.clashk.ing` hostname is needed. Clear old zone/R2 cache as part of retiring
   that serving path; this is separate from the new AssetOrigin cache purge.
7. Repeat production read/conditional/CORS probes before resuming releases.
   Do not configure release-triggered purging. Query cache-busters are deliberately
   discarded and do not force fresh edge content.
8. If cutover fails, pause releases, detach the Worker custom domain, restore the
   recorded R2 custom domain/public settings and prior DNS, and verify original
   URLs before resuming. Do not delete bucket objects or deployment history.

## Remaining app integration — no app files changed

Keep original URLs as the fallback and use AVIF only on supported decoder paths.
Use `.avif?size=<allowed size>` for raster thumbnails, selecting the smallest bound
covering physical display pixels (layout size × device scale), capped at 1024.
Keep animations on the original path unless the platform's AVIF result has been
verified to retain the intended animation; never silently substitute a thumbnail
for an animation. Keep SVG, fonts, audio and JSON URLs unchanged.

Implement a Clear image cache button that clears the native image library's memory
and disk entries, including original and AVIF URLs. Changing a query cache-buster
will not force a new edge variant. A refetch after an edge purge receives current
content, but previously saved device images otherwise retain their accepted TTL.

For JSON, retain a cached-first/offline body and validators. Check on login/resume
and at most once per minute while foregrounded, coalescing concurrent checks.
Prefer If-None-Match conditional GET: retain the body on 304, atomically replace
body and validators on 200, and keep the last good body on network failure. Existing
HEAD/Last-Modified followed by GET remains compatible during migration. No new
runtime manifest is required.

## Official capability and billing references (verified 2026-09-04)

- [Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
  documents entrypoint opt-in/out. The installed Wrangler schema accepts the
  configuration; `cross_version_cache` is global, not inside an export override.
- [Cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/)
  include path/query, entrypoint and version, with additional header partitions.
  This is why normalization happens in the uncached gateway before the cache.
- [Purge API](https://developers.cloudflare.com/workers/cache/purge/) specifies
  entrypoint scope, `purgeEverything`, result checking and rate limiting. Zone
  purge does not affect Workers Cache. Its rate limits use the Free-tier purge
  limits irrespective of the zone plan; backoff remains necessary.
- [Workers Cache pricing](https://developers.cloudflare.com/workers/cache/#pricing)
  charges requests even on hits, including cached loopback fetches; hits avoid
  origin-entrypoint CPU. Budget for the public gateway invocation plus the cached
  AssetOrigin invocation, not zero-cost cache hits. The gateway runs every time.
- [Images binding](https://developers.cloudflare.com/images/optimization/binding/)
  accepts private R2 bytes and recommends Workers Cache. It does not retain a
  response cache itself; an uncached call decodes/re-encodes again.
- [Images pricing](https://developers.cloudflare.com/images/pricing/) now bills
  binding calls per unique source/recipe per calendar month, with 5,000 included
  and $0.50 per additional 1,000 on Paid. R2-backed transformations do not add
  Images Stored/Delivered charges. If every one of the initial 2,983 source images
  uses all six recipes in one month, that is at most 17,898 requested recipes,
  roughly $6.45 beyond the included transformations, before Workers/R2 costs.
- [Image features](https://developers.cloudflare.com/images/optimization/features/#scale-down)
  confirm that square width/height with `fit: scale-down` preserves the full image
  and aspect ratio without enlargement. [Limits and formats](https://developers.cloudflare.com/images/get-started/limits/)
  still apply; unsupported or oversized conversions fail without caching errors.
