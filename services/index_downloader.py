from __future__ import annotations

import gzip
import os
import shutil
from pathlib import Path
from typing import Any

import httpx

from config import config
from utils.logger import logger

GITHUB_API = 'https://api.github.com'

RELEASE_ASSETS = {
    'index': 'index.json.gz',
    'embeddings': 'embeddings.i8.gz',
    'build_cache': 'build-cache.json.gz',
}


def _headers() -> dict[str, str]:
    h = {
        'User-Agent': 'PERBot',
        'X-GitHub-Api-Version': '2022-11-28',
        'Accept': 'application/vnd.github+json',
    }
    # The repo is public, so the token is optional; it only raises the rate limit.
    if config.github.token:
        h['Authorization'] = f'Bearer {config.github.token}'
    return h


def _get_release() -> dict[str, Any] | None:
    repo, tag = config.github.repo, config.github.index_release_tag
    res = httpx.get(f'{GITHUB_API}/repos/{repo}/releases/tags/{tag}', headers=_headers(), timeout=20)
    if not res.is_success:
        logger.warn(f'Release {tag} not available ({res.status_code}).')
        return None
    return res.json()


def _asset(release: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((a for a in release.get('assets', []) if a.get('name') == name), None)


def fetch_index_stamp() -> str | None:
    """`updated_at` of the index asset — the running bot polls this to pick up nightly rebuilds."""
    try:
        release = _get_release()
        asset = _asset(release, RELEASE_ASSETS['index']) if release else None
        return asset.get('updated_at') if asset else None
    except Exception as err:
        logger.warn('Could not read release stamp.', err)
        return None


def _download_asset(release: dict[str, Any], name: str, dest_path: str) -> bool:
    asset = _asset(release, name)
    if not asset:
        logger.warn(f'Asset {name} missing from release.')
        return False
    url = f"{GITHUB_API}/repos/{config.github.repo}/releases/assets/{asset['id']}"
    Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
    temp_path = f'{dest_path}.download.tmp'
    # ~60 MB gzipped at worst; a stalled CDN connection must not hang every /dt behind it.
    timeout = httpx.Timeout(10 * 60, connect=30)
    try:
        with httpx.stream(
            'GET', url, headers={**_headers(), 'Accept': 'application/octet-stream'}, timeout=timeout, follow_redirects=True
        ) as res:
            if not res.is_success:
                logger.warn(f'Download of {name} failed ({res.status_code}).')
                return False
            gz_path = f'{temp_path}.gz'
            with open(gz_path, 'wb') as f:
                for chunk in res.iter_bytes(1 << 20):
                    f.write(chunk)
        with gzip.open(gz_path, 'rb') as src, open(temp_path, 'wb') as dst:
            shutil.copyfileobj(src, dst, 1 << 20)
        os.unlink(gz_path)
        os.replace(temp_path, dest_path)
        return True
    except Exception:
        for p in (temp_path, f'{temp_path}.gz'):
            try:
                os.unlink(p)
            except OSError:
                pass
        raise


def download_index_from_release(dest: dict[str, str] | None = None) -> dict[str, str | None] | None:
    """Fetches the pre-built index (JSON + embeddings) for the bot. Writes to `dest` when given
    (used for hot-swapping a fresh nightly index without touching the live files first)."""
    dest = dest or {'index_path': config.app.index_path, 'embeddings_path': config.app.embeddings_path}
    try:
        logger.info(f'Fetching pre-built index from release {config.github.index_release_tag}...')
        release = _get_release()
        if not release:
            return None
        ok_index = _download_asset(release, RELEASE_ASSETS['index'], dest['index_path'])
        ok_emb = ok_index and _download_asset(release, RELEASE_ASSETS['embeddings'], dest['embeddings_path'])
        if not ok_index or not ok_emb:
            return None
        asset = _asset(release, RELEASE_ASSETS['index'])
        logger.info('Pre-built index downloaded and ready.')
        return {'stamp': asset.get('updated_at') if asset else None}
    except Exception as err:
        logger.error('Index download failed.', err)
        return None


def download_build_inputs_from_release() -> None:
    """For the indexer: previous index + embeddings + raw-markdown cache so unchanged pages are reused.
    Only fetches what is missing locally (the bot keeps index + embeddings but never the cache)."""
    try:
        wanted = [
            (RELEASE_ASSETS['index'], config.app.index_path),
            (RELEASE_ASSETS['embeddings'], config.app.embeddings_path),
            (RELEASE_ASSETS['build_cache'], config.app.build_cache_path),
        ]
        missing = [pair for pair in wanted if not os.path.exists(pair[1])]
        if not missing:
            return
        release = _get_release()
        if not release:
            return
        for name, dest in missing:
            try:
                _download_asset(release, name, dest)
            except Exception as e:
                logger.warn(f'Could not download {name}.', e)
    except Exception as err:
        logger.warn('Could not fetch previous build inputs; building from scratch.', err)
