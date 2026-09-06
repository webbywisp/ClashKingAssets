"""Validate the AVIF source contract against release assets; no output manifest."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

SOURCE_EXTENSIONS = {'.webp', '.png', '.jpg', '.jpeg'}


def check_image_sources(root: Path) -> dict[str, int]:
    if not root.is_dir():
        raise ValueError('assets directory is missing')
    sources: dict[str, list[str]] = defaultdict(list)
    real_avif_stems: set[str] = set()
    real_avif = 0
    for path in root.rglob('*'):
        if not path.is_file():
            continue
        key = path.relative_to(root).as_posix()
        if key.startswith('__admin/'):
            raise ValueError(f'asset uses reserved Worker path: {key}')
        if path.suffix in SOURCE_EXTENSIONS:
            sources[key.rsplit('.', 1)[0]].append(key)
        if path.suffix == '.avif':
            real_avif += 1
            real_avif_stems.add(key.rsplit('.', 1)[0])
    collisions = [
        sorted(paths)
        for stem, paths in sources.items()
        if len(paths) > 1 and stem not in real_avif_stems
    ]
    if collisions:
        raise ValueError(f'ambiguous AVIF sources: {collisions}')
    return {'image_sources': len(sources), 'real_avif_objects': real_avif, 'collisions': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets-root', type=Path, default=Path(__file__).parent / 'assets')
    args = parser.parse_args()
    print(json.dumps(check_image_sources(args.assets_root), sort_keys=True))
