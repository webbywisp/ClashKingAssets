"""Release-only client for the Assets Worker's authenticated, entrypoint-scoped purge."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


class WorkerPurgeError(RuntimeError):
    pass


USER_AGENT = 'ClashKingAssetsRelease/1.0 (+https://github.com/ClashKingInc/ClashKingAssets)'


@dataclass(frozen=True)
class WorkerPurgeConfig:
    url: str
    token: str


def load_worker_purge_config() -> WorkerPurgeConfig | None:
    url = os.getenv('ASSETS_WORKER_PURGE_URL', '').strip()
    token = os.getenv('ASSETS_WORKER_PURGE_TOKEN', '').strip()
    required = os.getenv('ASSETS_WORKER_PURGE_REQUIRED', '').strip().lower() == 'true'
    if not url and not token and not required:
        return None
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != 'https'
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
        or parsed.path != '/__admin/purge'
        or parsed.query
        or parsed.fragment
    ):
        raise WorkerPurgeError(
            'ASSETS_WORKER_PURGE_URL must be an HTTPS /__admin/purge URL without credentials or query'
        )
    if len(token) < 32:
        raise WorkerPurgeError('ASSETS_WORKER_PURGE_TOKEN must contain at least 32 characters')
    return WorkerPurgeConfig(url, token)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a CI credential to a redirected host/path.
        return None


def asset_cache_tag(key: str) -> str:
    family = (
        'image:' + re.sub(r'\.(webp|png|jpe?g|avif)$', '', key, flags=re.IGNORECASE)
        if re.search(r'\.(webp|png|jpe?g|avif)$', key, re.IGNORECASE)
        else 'file:' + key
    )
    return 'asset-' + hashlib.sha256(family.encode('utf-8')).hexdigest()


def purge_once(config: WorkerPurgeConfig, tags: list[str]) -> None:
    if not tags or len(tags) > 100 or any(not re.fullmatch(r'asset-[a-f0-9]{64}', tag) for tag in tags):
        raise WorkerPurgeError('Expected 1–100 asset tags')
    request = urllib.request.Request(
        config.url,
        method='POST',
        data=json.dumps({'tags': tags}).encode('utf-8'),
        headers={
            'Authorization': f'Bearer {config.token}',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
        },
    )
    opener = urllib.request.build_opener(NoRedirect())
    for attempt in range(3):
        try:
            with opener.open(request, timeout=30) as response:
                result = json.loads(response.read(4096))
                if (
                    response.status != 200
                    or not isinstance(result, dict)
                    or result.get('success') is not True
                    or result.get('scope') != 'AssetOrigin'
                ):
                    raise WorkerPurgeError('Assets Worker did not confirm an AssetOrigin cache purge')
                return
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504):
                raise WorkerPurgeError(
                    f'Assets Worker purge rejected (HTTP {exc.code}); check CI configuration'
                ) from None
        except (OSError, ValueError, WorkerPurgeError):
            pass
        if attempt < 2:
            time.sleep(5 * (attempt + 1))
    raise WorkerPurgeError(
        'Uploads completed but Assets Worker purge failed after 3 attempts. '
        'Cached content may be stale. Fix configuration/service availability, then run python worker_purge.py '
        'with --keys followed by the affected R2 keys and the same CI secrets, or rerun the same release.'
    )


def purge_worker_cache(config: WorkerPurgeConfig, keys: list[str]) -> None:
    tags = sorted({asset_cache_tag(key) for key in keys})
    if not tags:
        return
    for offset in range(0, len(tags), 100):
        purge_once(config, tags[offset : offset + 100])
    # Mitigates fills already running at the first purge. It is not a documented
    # atomic release barrier; the migration checklist requires a live race probe.
    time.sleep(60)
    for offset in range(0, len(tags), 100):
        purge_once(config, tags[offset : offset + 100])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Purge only the specified asset keys and their image variants')
    parser.add_argument('--keys', nargs='+', required=True)
    args = parser.parse_args()
    try:
        config = load_worker_purge_config()
        if config is None:
            raise WorkerPurgeError('Assets Worker purge is not configured')
        purge_worker_cache(config, args.keys)
        print(json.dumps({'success': True, 'scope': 'AssetOrigin', 'passes': 2}))
    except WorkerPurgeError as exc:
        raise SystemExit(str(exc)) from None
