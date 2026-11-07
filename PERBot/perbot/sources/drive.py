"""Google Shared Drive source. Scope is whatever the service account can see: every Shared
Drive it has been added to (or only `GDRIVE_DRIVE_IDS`), plus any folders in `GDRIVE_FOLDER_IDS`.
Subtrees under a folder named in `GDRIVE_EXCLUDE_FOLDERS` are skipped.

Text comes from Drive's own export for Google Docs (markdown, so headings survive), Slides
and Sheets; PDFs go through pypdf, .docx through mammoth, plain text/markdown/csv as-is.
CAD, images, video, spreadsheets in office formats and anything over `GDRIVE_MAX_FILE_MB`
are skipped. Extracted text is cached by file id + modifiedTime in the build cache.
"""
from __future__ import annotations

import io
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Literal

import httpx

from ..config import config
from ..models import BuildCache, CachedDriveFile
from ..utils.logger import logger
from .google_auth import ServiceAccountAuth
from .models import SourceDocument

API = 'https://www.googleapis.com/drive/v3'
FOLDER = 'application/vnd.google-apps.folder'
SHORTCUT = 'application/vnd.google-apps.shortcut'

# Google-native types → export MIME.
EXPORTS = {
    'application/vnd.google-apps.document': 'text/markdown',
    'application/vnd.google-apps.presentation': 'text/plain',
    'application/vnd.google-apps.spreadsheet': 'text/csv',
}

# Binary/uploaded types we can read.
DOWNLOADS: dict[str, Literal['pdf', 'docx', 'text']] = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'text/plain': 'text',
    'text/markdown': 'text',
    'text/csv': 'text',
}

MAX_SHEET_CHARS = 20_000
MAX_ATTEMPTS = 6
REV_FOLDER = re.compile(r'^REV\s?-?(\d{1,2})\b', re.I)


def _backoff(attempt: int) -> None:
    time.sleep((min(60_000, 2_000 * 2**attempt) + random.random() * 1_000) / 1000)


def _is_rate_limit(res: httpx.Response) -> bool:
    try:
        return re.search(r'rateLimitExceeded|userRateLimitExceeded|quotaExceeded', res.text, re.I) is not None
    except Exception:
        return False


DriveFile = dict[str, Any]  # id, name, mimeType, parents?, modifiedTime, createdTime, size?, webViewLink?, driveId?


@dataclass
class FileRoute:
    type: Literal['export', 'download', 'skip']
    mime: str = ''
    parser: Literal['pdf', 'docx', 'text', ''] = ''
    reason: str = ''


def route_file(file: DriveFile, max_bytes: float) -> FileRoute:
    mime = file.get('mimeType')
    if mime in (FOLDER, SHORTCUT):
        return FileRoute('skip', reason='container')
    export_mime = EXPORTS.get(mime or '')
    if export_mime:
        return FileRoute('export', mime=export_mime)
    parser = DOWNLOADS.get(mime or '')
    if not parser:
        return FileRoute('skip', reason=f'unsupported type {mime}')
    if file.get('size') and float(file['size']) > max_bytes:
        return FileRoute('skip', reason=f'over {round(max_bytes / 1e6)} MB')
    return FileRoute('download', parser=parser)


class FolderIndex:
    """Resolves breadcrumbs from the flat folder list a Shared Drive listing returns."""

    def __init__(self, folders: list[DriveFile], roots: dict[str, str], exclude_names: list[str], min_rev: int = 0):
        self._by_id = {f['id']: f for f in folders}
        self._roots = roots
        self._exclude = {n.lower() for n in exclude_names}
        self._min_rev = min_rev
        self._chain_cache: dict[str, list[str]] = {}

    def _excluded_name(self, name: str) -> bool:
        if name.lower() in self._exclude:
            return True
        rev = REV_FOLDER.match(name)
        return rev is not None and int(rev.group(1)) < self._min_rev

    def _chain(self, id_: str | None, depth: int = 0) -> list[str]:
        if not id_ or depth > 30:
            return []
        if id_ in self._roots:
            return [self._roots[id_]]
        cached = self._chain_cache.get(id_)
        if cached:
            return cached
        folder = self._by_id.get(id_)
        result = [*self._chain(_first_parent(folder), depth + 1), folder['name']] if folder else []
        self._chain_cache[id_] = result
        return result

    def path_of(self, file: DriveFile) -> list[str]:
        """Ancestor folder names for a file, top-down, starting with the drive name."""
        return self._chain(_first_parent(file))

    def excluded(self, file: DriveFile) -> bool:
        """True when any ancestor folder is in the exclusion list."""
        return any(self._excluded_name(n) for n in self._chain(_first_parent(file)))


def build_folder_index(
    folders: list[DriveFile], roots: dict[str, str], exclude_names: list[str], min_rev: int = 0
) -> FolderIndex:
    return FolderIndex(folders, roots, exclude_names, min_rev)


def _first_parent(file: DriveFile | None) -> str | None:
    parents = (file or {}).get('parents') or []
    return parents[0] if parents else None


def _cap(text: str, cap: int) -> str:
    return f'{text[:cap]}\n[… truncated …]' if len(text) > cap else text


def pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return '\n'.join((page.extract_text() or '') for page in reader.pages)


def docx_text(data: bytes) -> str:
    import mammoth

    return mammoth.extract_raw_text(io.BytesIO(data)).value


class DriveService:
    def __init__(self, auth: ServiceAccountAuth, http: httpx.Client | None = None):
        self._auth = auth
        self._http = http or httpx.Client(timeout=120, follow_redirects=True)

    def _get(self, path: str, params: dict[str, str], accept: str | None = None) -> httpx.Response:
        """GET with backoff. Drive signals rate limiting as 403 `userRateLimitExceeded` /
        `rateLimitExceeded` as often as 429, so both are retried with exponential backoff + jitter."""
        attempt = 0
        while True:
            headers = {'Authorization': f'Bearer {self._auth.access_token()}'}
            if accept:
                headers['Accept'] = accept
            try:
                res = self._http.get(f'{API}{path}', params=params, headers=headers)
            except httpx.TransportError:
                if attempt >= MAX_ATTEMPTS:
                    raise
                _backoff(attempt)
                attempt += 1
                continue
            if res.is_success:
                return res
            retryable = res.status_code == 429 or res.status_code >= 500 or (res.status_code == 403 and _is_rate_limit(res))
            if not retryable or attempt >= MAX_ATTEMPTS:
                return res
            _backoff(attempt)
            attempt += 1

    def _get_json(self, path: str, params: dict[str, str]) -> Any:
        res = self._get(path, params)
        if not res.is_success:
            raise RuntimeError(f'Drive {path} failed: {res.status_code} {res.text[:300]}')
        return res.json()

    def list_shared_drives(self) -> list[dict[str, str]]:
        drives: list[dict[str, str]] = []
        page_token: str | None = None
        while True:
            data = self._get_json('/drives', {'pageSize': '100', **({'pageToken': page_token} if page_token else {})})
            drives.extend(data.get('drives') or [])
            page_token = data.get('nextPageToken')
            if not page_token:
                return drives

    def _list_files(self, params: dict[str, str]) -> list[DriveFile]:
        files: list[DriveFile] = []
        page_token: str | None = None
        while True:
            data = self._get_json(
                '/files',
                {
                    'pageSize': '1000',
                    'supportsAllDrives': 'true',
                    'includeItemsFromAllDrives': 'true',
                    'fields': 'nextPageToken,files(id,name,mimeType,parents,modifiedTime,createdTime,size,webViewLink,driveId)',
                    **params,
                    **({'pageToken': page_token} if page_token else {}),
                },
            )
            files.extend(data.get('files') or [])
            page_token = data.get('nextPageToken')
            if not page_token:
                return files

    def list_drive(self, drive_id: str) -> list[DriveFile]:
        """Every non-trashed file and folder in one Shared Drive."""
        return self._list_files({'corpora': 'drive', 'driveId': drive_id, 'q': 'trashed = false'})

    def list_folder_tree(self, folder_id: str) -> tuple[DriveFile | None, list[DriveFile]]:
        """A folder subtree (any drive), breadth-first."""
        try:
            root = self._get_json(
                f'/files/{folder_id}',
                {'supportsAllDrives': 'true', 'fields': 'id,name,mimeType,parents,modifiedTime,createdTime,driveId'},
            )
        except Exception:
            root = None
        files: list[DriveFile] = []
        queue = [folder_id]
        seen: set[str] = set()
        while queue:
            id_ = queue.pop(0)
            if id_ in seen:
                continue
            seen.add(id_)
            for child in self._list_files({'corpora': 'allDrives', 'q': f"'{id_}' in parents and trashed = false"}):
                files.append(child)
                if child.get('mimeType') == FOLDER:
                    queue.append(child['id'])
        return root, files

    def file_text(self, file: DriveFile, route: FileRoute) -> str | None:
        if route.type == 'skip':
            return None
        if route.type == 'export':
            res = self._get(f"/files/{file['id']}/export", {'mimeType': route.mime})
            if res.status_code == 403 and route.mime == 'text/markdown':
                # Markdown export is capped at 10 MB and image-heavy Docs exceed it
                # (exportSizeLimitExceeded); plain text of the same doc always exports.
                res = self._get(f"/files/{file['id']}/export", {'mimeType': 'text/plain'})
            if not res.is_success:
                m = re.search(r'"reason":\s*"([^"]+)"', res.text)
                raise RuntimeError(f"export {res.status_code} {m.group(1) if m else ''}".strip())
            cap = MAX_SHEET_CHARS if route.mime == 'text/csv' else config.gdrive.max_doc_chars
            return _cap(res.text, cap)
        res = self._get(f"/files/{file['id']}", {'alt': 'media', 'supportsAllDrives': 'true'})
        if not res.is_success:
            raise RuntimeError(f'download {res.status_code}')
        if route.parser == 'pdf':
            text = pdf_text(res.content)
        elif route.parser == 'docx':
            text = docx_text(res.content)
        else:
            text = res.content.decode('utf-8', errors='replace')
        return _cap(text, config.gdrive.max_doc_chars)

    def build_documents(
        self,
        cache: BuildCache,
        on_progress: Callable[[dict[str, CachedDriveFile]], None] | None = None,
    ) -> tuple[list[SourceDocument], dict[str, CachedDriveFile]]:
        """Lists, extracts (or reuses cached text for) and packages every indexable Drive file.
        `on_progress` receives the partial text cache every 500 files so a killed first run can
        resume instead of starting over (the first pass over the FSAE drive takes hours)."""
        g = config.gdrive
        prev = cache.get('drive') or {}
        nxt: dict[str, CachedDriveFile] = {}
        docs: list[SourceDocument] = []
        counts = dict(drives=0, listed=0, fetched=0, cached=0, skipped=0, excluded=0, failed=0, empty=0)

        # Collect every file with the folder index that explains its breadcrumb.
        batches: list[tuple[list[DriveFile], FolderIndex]] = []

        drives = self.list_shared_drives()
        if g.drive_ids:
            drives = [d for d in drives if d['id'] in g.drive_ids]
        for drive in drives:
            all_files = self.list_drive(drive['id'])
            folders = [f for f in all_files if f.get('mimeType') == FOLDER]
            index = build_folder_index(folders, {drive['id']: drive['name']}, g.exclude_folder_names, g.min_rev)
            batches.append(([f for f in all_files if f.get('mimeType') != FOLDER], index))
            counts['drives'] += 1
            logger.info(f"Drive \"{drive['name']}\": {len(all_files) - len(folders)} files in {len(folders)} folders.")
        for folder_id in g.folder_ids:
            root, files = self.list_folder_tree(folder_id)
            folders = [f for f in files if f.get('mimeType') == FOLDER]
            root_name = (root or {}).get('name') or 'Drive folder'
            index = build_folder_index(folders, {folder_id: root_name}, g.exclude_folder_names, g.min_rev)
            batches.append(([f for f in files if f.get('mimeType') != FOLDER], index))
            logger.info(f"Drive folder \"{(root or {}).get('name') or folder_id}\": {len(files) - len(folders)} files.")

        # Decide what to read, then read it with a small pool: the first full run of the FSAE drive
        # (~6k readable files) was download-latency bound at ~1 file/s sequentially.
        work: list[tuple[DriveFile, FileRoute, FolderIndex]] = []
        for files, index in batches:
            for file in files:
                counts['listed'] += 1
                if index.excluded(file):
                    counts['excluded'] += 1
                    continue
                route = route_file(file, g.max_file_bytes)
                if route.type == 'skip':
                    counts['skipped'] += 1
                    continue
                work.append((file, route, index))
        if len(work) > g.max_files:
            logger.warn(
                f'Drive: {len(work)} readable files exceed GDRIVE_MAX_FILES={g.max_files}; indexing the first {g.max_files}.'
            )
            del work[g.max_files :]

        results: list[tuple[int, str] | None] = [None] * len(work)
        lock = threading.Lock()

        def read(i: int) -> None:
            file, route, _ = work[i]
            hit = prev.get(file['id'])
            if hit and hit['modifiedTime'] == file.get('modifiedTime'):
                results[i] = (i, hit['text'])
                with lock:
                    counts['cached'] += 1
            else:
                try:
                    results[i] = (i, self.file_text(file, route) or '')
                    with lock:
                        counts['fetched'] += 1
                except Exception as err:
                    with lock:
                        counts['failed'] += 1
                    logger.warn(f"Drive: skipping \"{file.get('name')}\" ({file['id']}): {err}")
            with lock:
                done = counts['fetched'] + counts['cached'] + counts['failed']
                report = done % 500 == 0
            if report:
                logger.info(
                    f"Drive: {done}/{len(work)} files read ({counts['fetched']} fetched, {counts['cached']} cached, {counts['failed']} failed)."
                )
                if on_progress:
                    partial: dict[str, CachedDriveFile] = dict(prev)
                    for r in list(results):
                        if r:
                            f = work[r[0]][0]
                            partial[f['id']] = {'modifiedTime': f.get('modifiedTime', ''), 'text': r[1]}
                    try:
                        on_progress(partial)
                    except Exception as err:
                        logger.warn('Drive: partial cache save failed.', err)

        with ThreadPoolExecutor(max_workers=max(1, g.concurrency)) as pool:
            list(pool.map(read, range(len(work))))

        for r in results:
            if not r:
                continue
            file, route, index = work[r[0]]
            text = r[1]
            nxt[file['id']] = {'modifiedTime': file.get('modifiedTime', ''), 'text': text}
            clean = re.sub(r'\n{3,}', '\n\n', re.sub(r'[ \t]+\n', '\n', text.replace('\r\n', '\n'))).strip()
            if len(clean) < config.app.min_page_chars:
                counts['empty'] += 1
                continue
            docs.append(
                SourceDocument(
                    id=f"drive:{file['id']}",
                    source='drive',
                    # Spreadsheets are data, not write-ups: rank them like Notion records.
                    kind='record' if route.type == 'export' and route.mime == 'text/csv' else 'doc',
                    title=re.sub(r'\.(pdf|docx|txt|md|csv)$', '', file.get('name', ''), flags=re.I),
                    url=file.get('webViewLink') or f"https://drive.google.com/file/d/{file['id']}/view",
                    ancestors=index.path_of(file),
                    clean_text=clean,
                    created_time=file.get('createdTime', ''),
                    last_edited_time=file.get('modifiedTime', ''),
                )
            )

        logger.info(
            f"Drive: {len(docs)} documents from {counts['drives']} shared drive(s) + {len(g.folder_ids)} folder(s) — "
            f"listed {counts['listed']}, fetched {counts['fetched']}, reused {counts['cached']}, skipped {counts['skipped']} unsupported, "
            f"{counts['excluded']} excluded, {counts['empty']} empty, {counts['failed']} failed."
        )
        return docs, nxt
