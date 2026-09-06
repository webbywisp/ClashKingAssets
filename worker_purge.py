"""Release-only client for the Assets Worker's authenticated, entrypoint-scoped purge."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


class WorkerPurgeError(RuntimeError):
    pass


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


def purge_once(config: WorkerPurgeConfig) -> None:
    request = urllib.request.Request(
        config.url, method='POST', headers={'Authorization': f'Bearer {config.token}', 'Accept': 'application/json'}
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
        'with the same CI secrets; do not roll back or republish assets merely to retry the purge.'
    )


def purge_worker_cache(config: WorkerPurgeConfig) -> None:
    purge_once(config)
    # Mitigates fills already running at the first purge. It is not a documented
    # atomic release barrier; the migration checklist requires a live race probe.
    time.sleep(60)
    purge_once(config)


if __name__ == '__main__':
    try:
        config = load_worker_purge_config()
        if config is None:
            raise WorkerPurgeError('Assets Worker purge is not configured')
        purge_worker_cache(config)
        print(json.dumps({'success': True, 'scope': 'AssetOrigin', 'passes': 2}))
    except WorkerPurgeError as exc:
        raise SystemExit(str(exc)) from None
