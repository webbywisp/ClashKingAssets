import json
import urllib.error
from pathlib import Path
from unittest.mock import Mock

import pytest

import build
import worker_purge
from check_image_sources import check_image_sources


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ('ASSETS_WORKER_PURGE_URL', 'ASSETS_WORKER_PURGE_TOKEN', 'ASSETS_WORKER_PURGE_REQUIRED'):
        monkeypatch.delenv(name, raising=False)


def test_purge_configuration_optional_before_cutover_and_required_after(monkeypatch):
    assert worker_purge.load_worker_purge_config() is None
    monkeypatch.setenv('ASSETS_WORKER_PURGE_REQUIRED', 'true')
    with pytest.raises(worker_purge.WorkerPurgeError):
        worker_purge.load_worker_purge_config()
    monkeypatch.setenv('ASSETS_WORKER_PURGE_URL', 'https://assets.clashk.ing/__admin/purge')
    monkeypatch.setenv('ASSETS_WORKER_PURGE_TOKEN', 'x' * 32)
    assert worker_purge.load_worker_purge_config().token == 'x' * 32


@pytest.mark.parametrize(
    'url',
    [
        'http://assets.clashk.ing/__admin/purge',
        'https://user:pass@assets.clashk.ing/__admin/purge',
        'https://assets.clashk.ing/wrong',
        'https://assets.clashk.ing/__admin/purge?scope=zone',
        'https://assets.clashk.ing/__admin/purge#fragment',
    ],
)
def test_purge_config_rejects_unsafe_urls(url, monkeypatch):
    monkeypatch.setenv('ASSETS_WORKER_PURGE_URL', url)
    monkeypatch.setenv('ASSETS_WORKER_PURGE_TOKEN', 'x' * 32)
    with pytest.raises(worker_purge.WorkerPurgeError):
        worker_purge.load_worker_purge_config()


def response(payload, status=200):
    result = Mock(status=status)
    result.read.return_value = json.dumps(payload).encode()
    result.__enter__ = Mock(return_value=result)
    result.__exit__ = Mock(return_value=False)
    return result


def test_purge_posts_secret_only_to_fixed_operation_and_does_two_passes(monkeypatch):
    events = []
    opener = Mock()

    def open_request(request, timeout):
        assert request.full_url == 'https://assets.clashk.ing/__admin/purge'
        assert request.method == 'POST'
        assert json.loads(request.data) == {'tags': [worker_purge.asset_cache_tag('a.webp')]}
        assert request.headers['Authorization'] == 'Bearer ' + 'x' * 32
        assert timeout == 30
        events.append('purge')
        return response({'success': True, 'scope': 'AssetOrigin'})

    opener.open.side_effect = open_request
    monkeypatch.setattr(worker_purge.urllib.request, 'build_opener', lambda handler: opener)
    monkeypatch.setattr(worker_purge.time, 'sleep', lambda delay: events.append(delay))
    worker_purge.purge_worker_cache(
        worker_purge.WorkerPurgeConfig('https://assets.clashk.ing/__admin/purge', 'x' * 32), ['a.webp']
    )
    assert events == ['purge', 60, 'purge']
    assert worker_purge.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test') is None


def test_purge_checks_scope_retries_and_sanitizes_failure(monkeypatch):
    opener = Mock()
    opener.open.return_value = response({'success': True, 'scope': 'zone'})
    monkeypatch.setattr(worker_purge.urllib.request, 'build_opener', lambda handler: opener)
    sleep = Mock()
    monkeypatch.setattr(worker_purge.time, 'sleep', sleep)
    with pytest.raises(worker_purge.WorkerPurgeError, match='python worker_purge.py') as error:
        worker_purge.purge_once(
            worker_purge.WorkerPurgeConfig('https://example.test/__admin/purge', 'SECRET'),
            [worker_purge.asset_cache_tag('a.webp')],
        )
    assert 'SECRET' not in str(error.value)
    assert opener.open.call_count == 3
    assert [call.args[0] for call in sleep.call_args_list] == [5, 10]


def test_purge_auth_failure_does_not_retry(monkeypatch):
    opener = Mock()
    opener.open.side_effect = urllib.error.HTTPError('https://example.test', 401, 'secret detail', {}, None)
    monkeypatch.setattr(worker_purge.urllib.request, 'build_opener', lambda handler: opener)
    with pytest.raises(worker_purge.WorkerPurgeError, match='HTTP 401'):
        worker_purge.purge_once(
            worker_purge.WorkerPurgeConfig('https://example.test/__admin/purge', 'secret'),
            [worker_purge.asset_cache_tag('a.webp')],
        )
    assert opener.open.call_count == 1


def test_releases_require_selective_purge_configuration():
    root = Path(__file__).resolve().parents[1]
    workflow = (root / '.github/workflows/release-assets.yml').read_text()
    source = (root / 'build.py').read_text()
    assert "ASSETS_WORKER_PURGE_REQUIRED: 'true'" in workflow
    assert 'purge_worker_cache' in source
    assert 'before_manifest=' in source
    assert workflow.count('\nconcurrency:') == 1


def test_image_family_tags_cover_aliases_but_not_unrelated_files():
    tag = worker_purge.asset_cache_tag('icons/a.webp')
    assert tag == worker_purge.asset_cache_tag('icons/a.avif')
    assert tag == worker_purge.asset_cache_tag('icons/a.png')
    assert tag != worker_purge.asset_cache_tag('icons/b.webp')
    assert tag != worker_purge.asset_cache_tag('icons/A.webp')
    assert tag != worker_purge.asset_cache_tag('icons/a.json')


def test_purge_batches_only_requested_families_and_skips_empty_work(monkeypatch):
    purge = Mock()
    monkeypatch.setattr(worker_purge, 'purge_once', purge)
    monkeypatch.setattr(worker_purge.time, 'sleep', Mock())
    config = worker_purge.WorkerPurgeConfig('https://example.test/__admin/purge', 'x' * 32)
    worker_purge.purge_worker_cache(config, [])
    purge.assert_not_called()
    keys = [f'icons/{n}.webp' for n in range(101)]
    worker_purge.purge_worker_cache(config, keys)
    assert [len(call.args[1]) for call in purge.call_args_list] == [100, 1, 100, 1]
    assert set(purge.call_args_list[0].args[1] + purge.call_args_list[1].args[1]) == {
        worker_purge.asset_cache_tag(key) for key in keys
    }


def test_source_collision_validation_and_real_layout(tmp_path):
    (tmp_path / 'a.webp').touch()
    (tmp_path / 'a.avif').touch()
    assert check_image_sources(tmp_path) == {'image_sources': 1, 'real_avif_objects': 1, 'collisions': 0}
    (tmp_path / 'a.png').touch()
    assert check_image_sources(tmp_path) == {'image_sources': 1, 'real_avif_objects': 1, 'collisions': 0}
    (tmp_path / 'a.avif').unlink()
    with pytest.raises(ValueError, match='ambiguous AVIF sources'):
        check_image_sources(tmp_path)
    assert check_image_sources(Path(__file__).resolve().parents[1] / 'assets')['collisions'] == 0


def test_partial_r2_upload_does_not_start_deletes(monkeypatch):
    client = Mock()
    client.upload_file.side_effect = RuntimeError('upload failed')
    monkeypatch.setattr(build, 'create_r2_client', lambda config: client)
    with pytest.raises(RuntimeError):
        build.apply_sync_plan(
            {'uploads': [{'local_path': 'assets/a.webp', 'key': 'a.webp'}], 'deletes': [{'key': 'old.webp'}]},
            build.R2Config('', '', '', 'assets'),
            1,
        )
    client.delete_objects.assert_not_called()
