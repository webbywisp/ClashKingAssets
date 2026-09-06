import hashlib
import json

import pytest

import build
from generate_manifest import build_manifest, image_is_animated
from update_static import StaticUpdater


def write_translation_files(matrix, root):
    updater = StaticUpdater.__new__(StaticUpdater)
    updater.BASE_PATH = str(root)
    updater.translation_data = matrix
    updater._write_translation_json_files()


def test_languages_are_split_and_preserve_unicode(tmp_path):
    write_translation_files({"TID": {"EN": "Arrow", "FR": "Flèche", "DE": ""}}, tmp_path)
    assert json.loads((tmp_path / "translations/FR.json").read_text()) == {"TID": "Flèche"}
    assert not (tmp_path / "translations/DE.json").exists()
    manifest = build_manifest(tmp_path)
    assert manifest["data"]["stats"] == []
    assert manifest["data"]["translations"][0]["path"] == "translations/EN.json"
    expected_sha = hashlib.sha256((tmp_path / "translations/EN.json").read_bytes()).hexdigest()
    assert manifest["data"]["translations"][0]["sha"] == expected_sha


def test_image_content_change_changes_manifest_hash(tmp_path):
    path = tmp_path / "item.webp"
    path.write_bytes(b"RIFF" + b"\0" * 4 + b"WEBPVP8X" + b"\0" * 4 + b"\x02" + b"\0" * 10)
    first = build_manifest(tmp_path)["assets"]["other"][0]
    assert first["animated"] is True
    path.write_bytes(path.read_bytes() + b"changed")
    assert build_manifest(tmp_path)["assets"]["other"][0]["sha"] != first["sha"]


def test_apng_detection(tmp_path):
    path = tmp_path / "item.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 4 + b"acTL")
    assert image_is_animated(path)


def test_gif_flag_distinguishes_single_and_multiple_frames(tmp_path):
    path = tmp_path / "item.gif"
    header = b"GIF89a" + b"\x01\0\x01\0\0\0\0"
    frame = b"\x2c" + b"\0" * 8 + b"\0\x02\x02\x44\x01\0"
    path.write_bytes(header + frame + b"\x3b")
    assert not image_is_animated(path)
    path.write_bytes(header + frame + frame + b"\x3b")
    assert image_is_animated(path)


def test_only_stale_generated_language_files_are_removed(tmp_path):
    write_translation_files({"TID": {"FR": "x", "EN": "y"}}, tmp_path)
    write_translation_files({"TID": {"EN": "y"}}, tmp_path)
    assert not (tmp_path / "translations/FR.json").exists()
    assert (tmp_path / "translations/EN.json").exists()


def test_release_publishes_manifest_after_referenced_files_and_deletes(monkeypatch):
    monkeypatch.setattr(build, "file_sha", lambda path: "a" * 64)
    calls = []

    class Client:
        def upload_file(self, path, bucket, key, **kwargs):
            calls.append(key)

        def delete_objects(self, **kwargs):
            calls.append("delete")
            return {}

    monkeypatch.setattr(build, "create_r2_client", lambda _: Client())
    plan = {
        "uploads": [{"key": key, "local_path": key} for key in ("manifest.json", "translations/FR.json")],
        "deletes": [{"key": "old.webp"}],
    }
    build.apply_sync_plan(
        plan, type("Config", (), {"bucket": "local-test"})(), 1,
        before_manifest=lambda: calls.append("purge changed families"),
    )
    assert calls == ["translations/FR.json", "delete", "purge changed families", "manifest.json"]

    calls.clear()

    def failed_purge():
        raise RuntimeError("purge failed")

    with pytest.raises(RuntimeError, match="purge failed"):
        build.apply_sync_plan(
            plan, type("Config", (), {"bucket": "local-test"})(), 1, before_manifest=failed_purge,
        )
    assert calls == ["translations/FR.json", "delete"]


def test_upload_failure_does_not_publish_manifest(monkeypatch):
    monkeypatch.setattr(build, "file_sha", lambda path: "a" * 64)
    calls = []

    class Client:
        def upload_file(self, path, bucket, key, **kwargs):
            calls.append(key)
            raise RuntimeError("upload failed")

    monkeypatch.setattr(build, "create_r2_client", lambda _: Client())
    plan = {
        "uploads": [{"key": key, "local_path": key} for key in ("manifest.json", "translations/FR.json")],
        "deletes": [],
    }
    with pytest.raises(RuntimeError):
        build.apply_sync_plan(plan, type("Config", (), {"bucket": "local-test"})(), 1)
    assert calls == ["translations/FR.json"]


@pytest.mark.parametrize("method", ["_parse_player_labels", "_parse_clan_labels"])
def test_label_exports_select_one_frame(method):
    updater = StaticUpdater.__new__(StaticUpdater)
    updater.open_file = lambda _: {"example": {"TID": "label", "IconSWF": "ui.sc", "IconExportName": "label"}}
    updater.is_ignored_id = lambda _: False
    updater._translate = lambda tid: "Example"
    requests = []
    updater.register_sc_asset = lambda **kwargs: requests.append(kwargs)
    getattr(updater, method)()
    assert len(requests) == 1
    assert requests[0]["first_frame"] is True
