"""Nightly index build. Incremental by default: the previous release's raw-markdown cache skips
the Notion fetch for unchanged pages, and its embeddings are reused for any chunk whose
embedded text is byte-identical (matched by sha1). A first run from nothing embeds everything.

Run: `python -m perbot.indexer`
"""
from __future__ import annotations

import hashlib
import math
import re
import sys
import traceback

import numpy as np

from .config import config, has_drive
from .models import BuildCache, CachedDriveFile, ChunkRecord, InferredBranch, InferredDocType, InferredSubsystem, PageRecord, SearchIndex
from .services.index_downloader import download_build_inputs_from_release
from .services.index_store import (
    index_exists,
    load_build_cache,
    quantize,
    read_index_files,
    save_build_cache,
    save_index,
    save_status,
)
from .services.llm import embed_texts
from .services.notion import NotionService
from .sources.drive import DriveService
from .sources.google_auth import ServiceAccountAuth, load_service_account_key
from .sources.models import SourceDocument
from .utils.chunk import ChunkOptions, build_embed_text, chunk_markdown
from .utils.clock import iso_now
from .utils.logger import logger
from .utils.notion_text import extract_doc_date, extract_rev_number


def infer_branch(path_text: str) -> InferredBranch:
    joined = path_text.lower()
    if 'mechanical' in joined:
        return 'mechanical'
    if 'electrical' in joined:
        return 'electrical'
    if 'operations' in joined or 'sponsorship' in joined or 'business' in joined:
        return 'operations'
    if 'software' in joined or 'firmware' in joined:
        return 'software'
    if 'general' in joined:
        return 'general'
    return 'unknown'


def infer_subsystem(path_text: str, head: str) -> InferredSubsystem:
    joined = f'{path_text} {head}'.lower()
    padded = f' {joined} '

    if 'accumulator' in joined or 'tractive system accumulator' in joined or ' tsa ' in padded:
        return 'accumulator'
    if 'aero' in joined or 'composites' in joined:
        return 'aero'
    if 'chassis' in joined:
        return 'chassis'
    if 'drivetrain' in joined:
        return 'drivetrain'
    if 'suspension' in joined:
        return 'suspension'
    if 'vehicle dynamics' in joined:
        return 'vehicle dynamics'
    if 'cooling' in joined or 'thermal' in joined or 'radiator' in joined:
        return 'cooling'
    if any(w in joined for w in ('driver interface', 'cockpit', 'pedal', 'steering')):
        return 'driver interface'
    if 'daqdash' in joined or 'daq-dash' in joined or ' daq ' in padded:
        return 'daqdash'
    if ' pcm ' in padded:
        return 'pcm'
    if 'high voltage' in joined or ' hv ' in padded:
        return 'hv'
    if 'low voltage' in joined or ' lv ' in padded:
        return 'lv'

    branch = infer_branch(path_text)
    if branch == 'mechanical':
        return 'general'
    if branch in ('electrical', 'operations', 'software'):
        return branch
    return 'unknown'


def infer_doc_type(title: str, path_text: str, head: str) -> InferredDocType:
    t = title.lower()
    joined = f'{path_text} {head}'.lower()

    if re.search(r'\b(meeting|minutes|agenda|weekly update|updates?)\b', t) or re.search(r'\b\d{1,2}/\d{1,2}\b', t):
        return 'meeting_notes'
    if t == 'home' or t.endswith(' home') or t.startswith('home '):
        return 'home'
    if re.search(r'\b(overview|intro|introduction|wiki|guide|readme|summary|how[- ]to|tutorial)\b', t):
        return 'overview'
    if re.search(r'\b(bom|bill of materials)\b', t):
        return 'bom'
    if re.search(r'\b(testing log|test log|testing logs)\b', t):
        return 'testing_logs'
    if re.search(r'\b(q&a|qa|questions|faq)\b', t):
        return 'qa'
    if re.search(r'\b(spec|specification|requirements)\b', t):
        return 'spec'
    if re.search(r'\b(design|architecture|packaging|cad|documentation|schematic)\b', joined):
        return 'design'
    if 'general' in joined:
        return 'general'
    return 'unknown'


def is_historical(path_text: str, rev_number: int | None, current_rev: int | None) -> bool:
    """"Historical" = older than last season. The current REV is in progress for most of the year,
    so last season's docs are usually the most complete write-up of anything that carried over and
    must not be penalized; REV(n-2) and older are."""
    if current_rev is not None and rev_number is not None and rev_number < current_rev - 1:
        return True
    return re.search(r'\b(archive|archived|historical|legacy|old season|deprecated|old)\b', path_text, re.I) is not None


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode('utf-8')).hexdigest()


def to_page_record(doc: SourceDocument, current_rev: int | None) -> PageRecord:
    path = [*doc.ancestors, doc.title]
    path_text = ' › '.join(path)
    head = doc.clean_text[:500]
    rev_number = extract_rev_number(doc.title, path_text, head)
    return {
        'id': doc.id,
        'source': doc.source,
        'kind': doc.kind,
        'title': doc.title,
        'url': doc.url,
        'path': path,
        'pathText': path_text,
        'createdTime': doc.created_time,
        'lastEditedTime': doc.last_edited_time,
        'revNumber': rev_number,
        'docDate': extract_doc_date(doc.title),
        'isHistorical': is_historical(path_text, rev_number, current_rev),
        'textLength': len(doc.clean_text),
        'inferredBranch': infer_branch(path_text),
        'inferredSubsystem': infer_subsystem(path_text, head),
        'inferredDocType': infer_doc_type(doc.title, path_text, head),
    }


def build_drive_documents(cache: BuildCache) -> tuple[list[SourceDocument], dict[str, CachedDriveFile] | None]:
    """Google Shared Drive documents, or none when the service account isn't configured or fails."""
    if not has_drive():
        logger.info('Google Drive source not configured (GDRIVE_SERVICE_ACCOUNT_JSON unset); Notion only.')
        return [], cache.get('drive')
    try:
        key = load_service_account_key(config.gdrive.service_account_json, config.gdrive.service_account_file)
        if not key:
            return [], cache.get('drive')
        auth = ServiceAccountAuth(key, ['https://www.googleapis.com/auth/drive.readonly'])
        logger.info(f'Google Drive source: indexing as {auth.email}.')
        return DriveService(auth).build_documents(cache, lambda partial: save_build_cache({**cache, 'drive': partial}))
    except Exception as err:
        # A Drive outage must not take the Notion index down with it; keep last night's Drive text.
        logger.error('Google Drive indexing failed; continuing with Notion only.', err)
        return [], cache.get('drive')


StoredVector = tuple[np.ndarray, float]


def load_previous_embeddings() -> dict[str, StoredVector]:
    reuse: dict[str, StoredVector] = {}
    if not config.app.index_incremental:
        return reuse
    # On Render the bot has index + embeddings but never the build cache; fetch whatever is missing.
    download_build_inputs_from_release()
    if not index_exists():
        return reuse
    try:
        index, embeddings = read_index_files()
        if index['embeddingModel'] != config.openai.embedding_model or index['embeddingDims'] != config.openai.embedding_dims:
            logger.info(
                f"Previous index used {index['embeddingModel']}@{index['embeddingDims']}; re-embedding everything with "
                f'{config.openai.embedding_model}@{config.openai.embedding_dims}.'
            )
            return reuse
        for i, chunk in enumerate(index['chunks']):
            reuse[chunk['hash']] = (embeddings[i], chunk['scale'])
        logger.info(f'Loaded {len(reuse)} previous embeddings for reuse.')
    except Exception as err:
        logger.warn('Previous index unreadable; re-embedding everything.', err)
    return reuse


def main() -> None:
    started_at = iso_now()
    logger.info('Starting PERBot Notion indexing job...')
    save_status({'state': 'indexing', 'phase': 'discovering', 'startedAt': started_at})

    previous = load_previous_embeddings()
    cache: BuildCache = load_build_cache() if config.app.index_incremental else {'version': 1, 'pages': {}}

    notion = NotionService()
    save_status({'state': 'indexing', 'phase': 'building_pages', 'startedAt': started_at})
    notion_docs, pages_cache = notion.build_indexable_documents(cache)
    drive_docs, drive_cache = build_drive_documents(cache)
    docs = [*notion_docs, *drive_docs]
    new_cache: BuildCache = {'version': 1, 'pages': pages_cache}
    if drive_cache:
        new_cache['drive'] = drive_cache
    save_build_cache(new_cache)

    save_status({'state': 'indexing', 'phase': 'chunking', 'startedAt': started_at, 'totalPages': len(docs)})
    digits = re.sub(r'\D', '', config.app.current_rev)
    current_rev_number = int(digits) if digits and int(digits) else None
    pages: list[PageRecord] = []
    chunks: list[ChunkRecord] = []
    embed_inputs: list[str] = []
    opts = ChunkOptions(target=config.app.chunk_target_chars, max=config.app.chunk_max_chars, min=config.app.chunk_min_chars)

    for doc in docs:
        page = to_page_record(doc, current_rev_number)
        pieces = chunk_markdown(doc.clean_text, opts)
        if not pieces:
            continue
        # Cap chunks per document so one 200-page datasheet can't dominate the index or the memory budget.
        if doc.source != 'drive':
            cap = config.app.max_chunks_per_doc
        elif doc.kind == 'record':
            cap = config.gdrive.record_max_chunks
        elif any(re.search('datasheet', a, re.I) for a in doc.ancestors):
            cap = config.gdrive.datasheet_max_chunks
        else:
            cap = config.gdrive.max_chunks_per_doc
        pieces = pieces[:cap]
        pages.append(page)
        for chunk_index, piece in enumerate(pieces):
            embed_text = build_embed_text(page['title'], doc.ancestors, piece.heading, piece.text)
            chunks.append(
                {
                    'id': f"{page['id']}:{chunk_index}",
                    'pageId': page['id'],
                    'chunkIndex': chunk_index,
                    'heading': piece.heading,
                    'text': piece.text,
                    'hash': sha1(embed_text),
                    'scale': 0,
                }
            )
            embed_inputs.append(embed_text)
    logger.info(f'Prepared {len(chunks)} chunks from {len(pages)} pages.')

    # Reuse what we can, embed the rest.
    dims = len(next(iter(previous.values()))[0]) if previous else 0
    vectors: list[StoredVector | None] = [previous.get(c['hash']) for c in chunks]
    to_embed = [i for i, v in enumerate(vectors) if v is None]
    reused = len(chunks) - len(to_embed)
    logger.info(f'Reusing {reused} embeddings; embedding {len(to_embed)} new chunks.')
    save_status(
        {
            'state': 'indexing',
            'phase': 'embedding',
            'startedAt': started_at,
            'totalPages': len(pages),
            'totalChunks': len(chunks),
            'reusedEmbeddings': reused,
            'totalChunkBatches': math.ceil(len(to_embed) / 100),
            'embeddedChunkBatches': 0,
        }
    )

    def on_batch(done: int, total: int) -> None:
        logger.info(f'Embedded batch {done} / {total}')
        if done % 10 != 0 and done != total:
            return
        try:
            save_status(
                {
                    'state': 'indexing',
                    'phase': 'embedding',
                    'startedAt': started_at,
                    'totalPages': len(pages),
                    'totalChunks': len(chunks),
                    'reusedEmbeddings': reused,
                    'totalChunkBatches': total,
                    'embeddedChunkBatches': done,
                }
            )
        except Exception as err:
            logger.warn('Could not write index status.', err)

    fresh = embed_texts([embed_inputs[i] for i in to_embed], on_batch)
    for k, chunk_idx in enumerate(to_embed):
        vectors[chunk_idx] = quantize(fresh[k])

    final_dims = dims or next((len(v[0]) for v in vectors if v is not None), 0)
    if not final_dims:
        raise RuntimeError('No embeddings produced.')
    embeddings = np.zeros((len(chunks), final_dims), dtype=np.int8)
    for i, v in enumerate(vectors):
        if v is None or len(v[0]) != final_dims:
            raise RuntimeError(f'Chunk {i} has no embedding of the expected size.')
        embeddings[i] = v[0]
        chunks[i]['scale'] = v[1]

    save_status({'state': 'indexing', 'phase': 'saving', 'startedAt': started_at, 'totalPages': len(pages), 'totalChunks': len(chunks)})
    index: SearchIndex = {
        'version': 3,
        'generatedAt': iso_now(),
        'currentRev': config.app.current_rev,
        'embeddingModel': config.openai.embedding_model,
        'embeddingDims': final_dims,
        'pages': pages,
        'chunks': chunks,
    }
    save_index(index, embeddings)
    save_status(
        {
            'state': 'ready',
            'phase': 'complete',
            'startedAt': started_at,
            'completedAt': iso_now(),
            'generatedAt': index['generatedAt'],
            'indexedPages': len(pages),
            'indexedChunks': len(chunks),
            'reusedEmbeddings': reused,
        }
    )
    logger.info(f'Saved PERBot index ({len(pages)} pages, {len(chunks)} chunks) to {config.app.index_path}')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        logger.error('Indexing failed.', error)
        save_status({'state': 'error', 'phase': 'error', 'failedAt': iso_now(), 'lastError': traceback.format_exc()})
        sys.exit(1)
