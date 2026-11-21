"""PER docs search: the nightly Notion / Drive index, hybrid BM25 + vector retrieval, and `/dt`,
`/reindex`, `/indexstatus` and @PERBot docs answers in Slack.

  feature.py            Search: the commands and the index load / refresh task
  bot.py                IndexManager (load / hot-swap / reindex) and DocSearch (the answers)
  engine.py             hybrid retrieval over chunks
  bm25.py               the BM25 index
  rrf.py                reciprocal rank fusion
  llm.py                embeddings, answers, rerank
  chunk.py              heading-aware chunking
  notion.py             the Notion crawler
  notion_text.py        Notion markdown export → searchable markdown
  drive.py              the Google Shared Drive crawler
  google_auth.py        service-account auth for Google APIs
  sources.py            SourceDocument
  models.py             shared record shapes
  index_store.py        reads / writes the index and int8 embeddings
  index_downloader.py   pulls the nightly index from the GitHub release
  slack_format.py       Block Kit for results

Run with `python -m`:

  indexer.py            `python -m search.indexer`: build the index

eval/ holds the retrieval eval (`python -m search.eval.run`).
"""

from .bm25 import *
from .bot import *
from .chunk import *
from .drive import *
from .engine import *
from .feature import *
from .google_auth import *
from .index_downloader import *
from .index_store import *
from .llm import *
from .models import *
from .notion import *
from .notion_text import *
from .rrf import *
from .slack_format import *
from .sources import *

__all__ = (
    'K1', 'B', 'Posting', 'BM25Index', 'is_indexable_term', 'build_bm25_index', 'idf',
    'bm25_query', 'LOGS_HINT', 'format_status', 'user_can_reindex', 'IndexManager', 'Answer',
    'DocSearch', 'TextChunk', 'ChunkOptions', 'HEADING_RE', 'chunk_markdown',
    'build_embed_text', 'sleep', 'API', 'FOLDER', 'SHORTCUT', 'EXPORTS', 'DOWNLOADS',
    'MAX_SHEET_CHARS', 'MAX_ATTEMPTS', 'REV_FOLDER', 'DriveFile', 'FileRoute', 'route_file',
    'FolderIndex', 'build_folder_index', 'pdf_text', 'docx_text', 'DriveService',
    'VECTOR_CANDIDATES', 'BM25_CANDIDATES', 'RERANK_CANDIDATES', 'WEAK_COSINE', 'GLOSSARY',
    'UPPERCASE_ONLY', 'HIGH_LEVEL_HINTS', 'NOTES_HINTS', 'parse_query', 'expand_terms',
    'RankedPage', 'rank_pages', 'search_index', 'context_for_result', 'Search', 'TOKEN_URI',
    'ServiceAccountKey', 'parse_service_account_key', 'load_service_account_key',
    'build_assertion', 'ServiceAccountAuth', 'GITHUB_API', 'RELEASE_ASSETS',
    'fetch_index_stamp', 'download_index_from_release', 'download_build_inputs_from_release',
    'LoadedIndex', 'get_loaded_index', 'set_loaded_index', 'save_index', 'read_index_files',
    'quantize', 'assemble_index', 'load_index', 'index_exists', 'load_build_cache',
    'save_build_cache', 'load_status', 'save_status', 'EMBEDDING_BATCH_SIZE',
    'MAX_EMBED_RETRIES', 'get_openai_client', 'embed_texts', 'embed_query', 'RerankCandidate',
    'rerank_results', 'AnswerSource', 'NO_OPENAI_NOTE', 'answer_from_sources', 'MentionIntent',
    'THREAD_HINT', 'heuristic_intent', 'classify_mention', 'ThreadMessage', 'summarize_thread',
    'InferredBranch', 'InferredSubsystem', 'InferredDocType', 'SourceKind', 'DocKind',
    'QueryFilters', 'ParsedQuery', 'PageRecord', 'ChunkRecord', 'SearchIndex', 'CachedPage',
    'CachedDriveFile', 'BuildCache', 'IndexStatus', 'SearchResult', 'SearchResponse', 'Block',
    'RawNotionPage', 'norm_id', 'rich_text', 'extract_title', 'is_database_row',
    'properties_text', 'NotionService', 'SELF_CLOSING_DROP', 'UNWRAP', 'MONTHS',
    'clean_notion_markdown', 'is_template_placeholder', 'extract_rev_number',
    'extract_doc_date', 'RRF_K', 'reciprocal_rank_fusion', 'ResultMeta', 'build_result_blocks',
    'SourceDocument',
)
