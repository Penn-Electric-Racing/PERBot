from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _env(name: str) -> str:
    return (os.environ.get(name) or '').strip()


def required(name: str) -> str:
    value = _env(name)
    if not value:
        raise RuntimeError(f'Missing required environment variable: {name}')
    return value


def require_any(names: list[str]) -> str:
    """Require at least one of several env var names (accepts either naming convention)."""
    for name in names:
        value = _env(name)
        if value:
            return value
    raise RuntimeError(f"Missing required environment variable: one of {' / '.join(names)}")


def optional_number(name: str, fallback: float) -> float:
    value = _env(name)
    if not value:
        return fallback
    try:
        parsed = float(value)
    except ValueError:
        raise RuntimeError(f'Environment variable {name} must be a number.') from None
    return int(parsed) if parsed.is_integer() else parsed


def optional_string(name: str, fallback: str) -> str:
    return _env(name) or fallback


def optional_list(name: str, fallback: list[str] | None = None) -> list[str]:
    value = _env(name)
    if not value:
        return list(fallback or [])
    return [item.strip() for item in value.split(',') if item.strip()]


def _resolve(p: str) -> str:
    return str(Path(p).resolve())


@dataclass
class SlackConfig:
    bot_token: str = field(default_factory=lambda: required('SLACK_BOT_TOKEN'))
    # Only Socket Mode (the main app) needs the app token; scheduled jobs that import
    # config don't. The socket handler will surface a clear error if it's missing at runtime.
    app_token: str = field(default_factory=lambda: _env('SLACK_APP_TOKEN'))
    bot_user_id: str = field(default_factory=lambda: _env('SLACK_BOT_USER_ID'))
    reindex_allowed_user_ids: list[str] = field(default_factory=lambda: optional_list('SLACK_REINDEX_ALLOWED_USER_IDS'))
    anon_allowed_channels: list[str] = field(
        default_factory=lambda: optional_list(
            'ANON_ALLOWED_CHANNELS', ['mech_questions', 'ele_questions', 'operations', 'sof_questions']
        )
    )


@dataclass
class NotionConfig:
    # Accept either name — the main app used NOTION_TOKEN; PER's other jobs use NOTION_API_KEY.
    token: str = field(default_factory=lambda: require_any(['NOTION_TOKEN', 'NOTION_API_KEY']))
    api_version: str = field(default_factory=lambda: optional_string('NOTION_API_VERSION', '2026-03-11'))
    allowed_page_ids: list[str] = field(default_factory=lambda: optional_list('NOTION_ALLOWED_PAGE_IDS'))
    # Database rows are skipped by the doc indexer unless they carry a real write-up. Data
    # sources listed here are indexed as `record`s (title + property values) regardless.
    index_data_source_ids: list[str] = field(default_factory=lambda: optional_list('NOTION_INDEX_DATA_SOURCE_IDS'))
    # ⚙️ PERBot Job Log — per-day run records so late/duplicate cron fires never re-send
    # (see utils/schedule.py). Empty disables dedup (with a warning).
    job_log_data_source_id: str = field(
        default_factory=lambda: optional_string('NOTION_JOB_LOG_DS_ID', 'db0c6a0d-e10b-4edf-97fb-6f381d15a465')
    )


@dataclass
class OpenAIConfig:
    api_key: str = field(default_factory=lambda: _env('OPENAI_API_KEY'))
    # The answer is written from the retrieved chunks; gpt-5-mini is plenty and ~10x cheaper/faster.
    response_model: str = field(default_factory=lambda: optional_string('OPENAI_RESPONSE_MODEL', 'gpt-5-mini'))
    embedding_model: str = field(default_factory=lambda: optional_string('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'))
    # text-embedding-3 models can be shortened; 768 dims halves the vector memory for a negligible
    # ranking loss (the bot holds every vector in RAM on a 512 MB worker).
    embedding_dims: int = field(default_factory=lambda: int(optional_number('OPENAI_EMBEDDING_DIMS', 1536)))


@dataclass
class GroqConfig:
    api_key: str = field(default_factory=lambda: _env('GROQ_API_KEY'))
    # llama-3.3-70b-versatile is decommissioned by Groq Aug 16 2026 → openai/gpt-oss-120b
    # (a reasoning model; call sites run it at reasoning_effort='low' for these bounded tasks).
    model: str = field(default_factory=lambda: optional_string('GROQ_MODEL', 'openai/gpt-oss-120b'))


@dataclass
class HunterConfig:
    # Contact/email enrichment + verification. Free tier = 50 credits/mo.
    api_key: str = field(default_factory=lambda: _env('HUNTER_API_KEY'))


@dataclass
class SponsorshipConfig:
    # Notion data-source IDs for the Sponsorship CRM.
    bank_data_source_id: str = field(
        default_factory=lambda: optional_string('SPONSOR_BANK_DS_ID', 'fd42b16b-2833-42c3-b72d-f6322145ed4e')
    )
    pipeline_data_source_id: str = field(
        default_factory=lambda: optional_string('SPONSOR_PIPELINE_DS_ID', '64bb332e-543c-4286-9e67-c3bda963cfdd')
    )
    # Won-deal win posts land here; also the semester goal for the running % line.
    win_post_channel: str = field(default_factory=lambda: optional_string('SPONSOR_WIN_CHANNEL', 'operations'))
    semester_goal_usd: float = field(default_factory=lambda: optional_number('SPONSOR_SEMESTER_GOAL_USD', 100000))
    # The team's outreach template page ("Sponsorship Email Template" under REV12
    # Operations) — fetched live by /sponsor email so ops can edit it without a deploy.
    email_template_page_id: str = field(
        default_factory=lambda: optional_string('SPONSOR_EMAIL_TEMPLATE_PAGE_ID', '393560bc-c039-8097-be19-fdc8876bef9b')
    )
    # Weekly quota audit (Saturday 10am ET): who's on the hook (👥 Ops Quota Roster), the
    # per-week record (📋 Weekly Quota Audit), where the call-out lands, and the bar.
    quota_roster_data_source_id: str = field(
        default_factory=lambda: optional_string('SPONSOR_QUOTA_ROSTER_DS_ID', '62729c68-535c-4dd0-a633-2feaf6e2b853')
    )
    quota_audit_data_source_id: str = field(
        default_factory=lambda: optional_string('SPONSOR_QUOTA_AUDIT_DS_ID', '784770f3-8276-4347-89e0-d677c53576a2')
    )
    quota_audit_url: str = field(
        default_factory=lambda: optional_string(
            'SPONSOR_QUOTA_AUDIT_URL', 'https://www.notion.so/acc29c47cfd44d02b5e5835d5ed6a090'
        )
    )
    quota_channel: str = field(default_factory=lambda: optional_string('SPONSOR_QUOTA_CHANNEL', 'perbot_spam'))
    weekly_quota: float = field(default_factory=lambda: optional_number('SPONSOR_WEEKLY_QUOTA', 3))


@dataclass
class OpsTasksConfig:
    # Ops Tasks database under REV12 Operations: one row per action item a member types under
    # their name on the Saturday meeting page.
    data_source_id: str = field(
        default_factory=lambda: optional_string('OPS_TASKS_DS_ID', 'a8afc6ec-29d6-4308-b779-ad4235b35e80')
    )
    # Ops Meetings database (one row per Saturday meeting page, Date property). Tasks link to a
    # row via the `Meeting` relation; each page's "This week" table filters on that relation.
    meetings_data_source_id: str = field(
        default_factory=lambda: optional_string('OPS_MEETINGS_DS_ID', 'f0e637cd-db29-4a8d-883f-c8c5603db02f')
    )
    # The database's "My open" view (Owner = me, Status != Done) — linked from the digest DM.
    my_open_view_url: str = field(
        default_factory=lambda: optional_string(
            'OPS_TASKS_MY_OPEN_URL',
            'https://www.notion.so/20cbf9381bcb45f99125e1468de321a3?v=3d8560bcc0398150b213000c6479f533',
        )
    )


@dataclass
class BenbuysMailConfig:
    # gmail (OAuth2 refresh token on the electric@ mailbox) | webhook (POST JSON to a URL)
    transport: str = field(default_factory=lambda: optional_string('BENBUYS_MAIL_TRANSPORT', 'gmail'))
    gmail_client_id: str = field(default_factory=lambda: _env('BENBUYS_GMAIL_CLIENT_ID'))
    gmail_client_secret: str = field(default_factory=lambda: _env('BENBUYS_GMAIL_CLIENT_SECRET'))
    gmail_refresh_token: str = field(default_factory=lambda: _env('BENBUYS_GMAIL_REFRESH_TOKEN'))
    webhook_url: str = field(default_factory=lambda: _env('BENBUYS_MAIL_WEBHOOK_URL'))


@dataclass
class BenbuysDigikeyConfig:
    to: list[str] = field(default_factory=lambda: optional_list('BENBUYS_DIGIKEY_TO', ['purchasing@engineering.upenn.edu']))
    description: str = field(
        default_factory=lambda: optional_string('BENBUYS_DIGIKEY_DESCRIPTION', 'PER electrical purchase')
    )
    justification: str = field(
        default_factory=lambda: optional_string(
            'BENBUYS_DIGIKEY_JUSTIFICATION', "This is a purchase for PER's electrical subteam."
        )
    )
    # Slack user ids allowed to run `done` (Katherine Shen).
    operators: list[str] = field(default_factory=lambda: optional_list('BENBUYS_DIGIKEY_OPERATORS', ['U09GD5JKSBW']))
    signature_name: str = field(default_factory=lambda: optional_string('BENBUYS_DIGIKEY_SIGNATURE', 'Katherine Shen'))


@dataclass
class BenbuysConfig:
    # BenBuys ordering helper (/benbuys prep|done). Source of truth = Purchasing (PEFS) DB.
    purchasing_data_source_id: str = field(
        default_factory=lambda: optional_string('BENBUYS_PURCHASING_DS_ID', '39e560bc-c039-83db-9f16-076cb18f7d7b')
    )
    season: str = field(default_factory=lambda: optional_string('BENBUYS_SEASON', 'REV12'))
    # Shared across vendors: the sending mailbox, the constant CC pair, and the BEN approval bar.
    from_addr: str = field(default_factory=lambda: optional_string('BENBUYS_FROM', 'electric@engineering.upenn.edu'))
    cc: list[str] = field(
        default_factory=lambda: optional_list('BENBUYS_CC', ['oat@engineering.upenn.edu', 'arjunsh@sas.upenn.edu'])
    )
    approval_threshold: float = field(default_factory=lambda: optional_number('BENBUYS_APPROVAL_THRESHOLD', 500))
    # DigiKey's customer-reference field is length-capped (spec assumes 35; confirm on the first real run).
    reference_max_chars: int = field(default_factory=lambda: int(optional_number('BENBUYS_REFERENCE_MAX_CHARS', 35)))
    mail: BenbuysMailConfig = field(default_factory=BenbuysMailConfig)
    digikey: BenbuysDigikeyConfig = field(default_factory=BenbuysDigikeyConfig)


@dataclass
class RaceConfig:
    # /race: the REV12 members' time trial leaderboard (Supabase). The service_role key is a server
    # secret; unset ⇒ /race just links to the game.
    supabase_url: str = field(default_factory=lambda: optional_string('RACE_SUPABASE_URL', ''))
    service_key: str = field(default_factory=lambda: _env('RACE_SUPABASE_SERVICE_KEY'))
    site_url: str = field(default_factory=lambda: optional_string('RACE_SITE_URL', 'https://race.pennelectricracing.com'))


@dataclass
class PriceCheckConfig:
    # 💸 Price Check Savings (under Purchasing — PEFS): one row per price-listener alert, updated
    # when someone taps Use / Keep / Undo; /pricecheck stats reads it. Empty disables the ledger.
    ledger_data_source_id: str = field(
        default_factory=lambda: optional_string('PRICE_CHECK_LEDGER_DS_ID', 'dd1818e3-82cd-461b-8071-12af3b0f1341')
    )
    ledger_url: str = field(
        default_factory=lambda: optional_string(
            'PRICE_CHECK_LEDGER_URL', 'https://www.notion.so/9269079476304d29be9dcb3dedac7e15'
        )
    )


@dataclass
class ArrivalsConfig:
    # Packing-slip photos posted here are matched to open Purchasing rows (same DB + season as
    # BenBuys). Channel name or id; empty disables the listener.
    channel: str = field(default_factory=lambda: optional_string('ARRIVALS_CHANNEL', ''))
    # Must accept images — Groq's gpt-oss-120b doesn't, so this is an OpenAI model.
    vision_model: str = field(default_factory=lambda: optional_string('ARRIVALS_VISION_MODEL', 'gpt-5-mini'))


def _default_min_rev() -> int:
    digits = re.sub(r'\D', '', optional_string('CURRENT_REV', 'REV12'))
    return (int(digits) if digits and int(digits) else 12) - 2


@dataclass
class GDriveConfig:
    # Google Shared Drive source for /dt. A service account key, as raw JSON or base64
    # (secret `GDRIVE_SERVICE_ACCOUNT_JSON`) or a file path. Unset ⇒ the Drive source is skipped.
    service_account_json: str = field(default_factory=lambda: _env('GDRIVE_SERVICE_ACCOUNT_JSON'))
    service_account_file: str = field(default_factory=lambda: _env('GDRIVE_SERVICE_ACCOUNT_FILE'))
    # Empty = every Shared Drive the service account has been added to.
    drive_ids: list[str] = field(default_factory=lambda: optional_list('GDRIVE_DRIVE_IDS'))
    # Extra folders (any drive) shared with the service account, walked recursively.
    folder_ids: list[str] = field(default_factory=lambda: optional_list('GDRIVE_FOLDER_IDS'))
    # Subtrees under a folder with one of these names are skipped (case-insensitive).
    # Media, raw telemetry logs, and the textbook/other-team dumps under Common Resources: none of
    # it is PER documentation, and together it was 60% of the Drive chunks on the first full run.
    exclude_folder_names: list[str] = field(
        default_factory=lambda: optional_list(
            'GDRIVE_EXCLUDE_FOLDERS',
            [
                'Photos', 'Pictures', 'Media', 'Videos', 'Archive', 'logs',
                'D_TEXTBOOKS', 'Springer Books', 'y_RESOURCES-TEAMS', 'y_RESOURCES-OTHER',
            ],
        )
    )
    # Chunk caps per Drive document (Notion uses MAX_CHUNKS_PER_DOC). Datasheets are matched by a
    # folder named like "datasheet"; records are spreadsheets.
    max_chunks_per_doc: int = field(default_factory=lambda: int(optional_number('GDRIVE_MAX_CHUNKS_PER_DOC', 20)))
    datasheet_max_chunks: int = field(default_factory=lambda: int(optional_number('GDRIVE_DATASHEET_MAX_CHUNKS', 8)))
    record_max_chunks: int = field(default_factory=lambda: int(optional_number('GDRIVE_RECORD_MAX_CHUNKS', 4)))
    max_file_bytes: float = field(default_factory=lambda: optional_number('GDRIVE_MAX_FILE_MB', 20) * 1_000_000)
    max_files: int = field(default_factory=lambda: int(optional_number('GDRIVE_MAX_FILES', 20000)))
    # Parallel downloads/exports. Drive's per-user quota is generous; 6 keeps well under it.
    concurrency: int = field(default_factory=lambda: int(optional_number('GDRIVE_CONCURRENCY', 6)))
    # Folders named "REVn" with n below this are skipped (default: two seasons before CURRENT_REV).
    # The FSAE drive holds ~66k files under REV7/REV8 alone; last two seasons + shared folders is the
    # useful slice, and anything older is "historical" for ranking anyway.
    min_rev: int = field(default_factory=lambda: int(optional_number('GDRIVE_MIN_REV', _default_min_rev())))
    # Characters kept per file (Docs export / PDF text). Long datasheets are cut, not skipped.
    max_doc_chars: int = field(default_factory=lambda: int(optional_number('GDRIVE_MAX_DOC_CHARS', 60_000)))


@dataclass
class GitHubConfig:
    token: str = field(default_factory=lambda: _env('GITHUB_TOKEN'))
    repo: str = field(default_factory=lambda: optional_string('GITHUB_REPO', 'Penn-Electric-Racing/PERBot'))
    index_release_tag: str = field(default_factory=lambda: optional_string('GITHUB_INDEX_RELEASE_TAG', 'notion-index-latest'))


@dataclass
class AppConfig:
    current_rev: str = field(default_factory=lambda: optional_string('CURRENT_REV', 'REV12'))
    top_k_results: int = field(default_factory=lambda: int(optional_number('TOP_K_RESULTS', 5)))
    # Two-file index: lean JSON (pages + chunk text) next to one raw int8 array of embeddings.
    index_path: str = field(default_factory=lambda: _resolve(optional_string('INDEX_PATH', './data/index.json')))
    embeddings_path: str = field(default_factory=lambda: _resolve(optional_string('EMBEDDINGS_PATH', './data/embeddings.i8')))
    build_cache_path: str = field(
        default_factory=lambda: _resolve(optional_string('INDEX_BUILD_CACHE_PATH', './data/build-cache.json'))
    )
    status_path: str = field(default_factory=lambda: _resolve(optional_string('INDEX_STATUS_PATH', './data/index-status.json')))
    chunk_target_chars: int = field(default_factory=lambda: int(optional_number('CHUNK_TARGET_CHARS', 900)))
    chunk_max_chars: int = field(default_factory=lambda: int(optional_number('CHUNK_MAX_CHARS', 1400)))
    chunk_min_chars: int = field(default_factory=lambda: int(optional_number('CHUNK_MIN_CHARS', 250)))
    max_chunks_per_doc: int = field(default_factory=lambda: int(optional_number('MAX_CHUNKS_PER_DOC', 60)))
    # Database rows need at least this much cleaned body text to be indexed as a doc.
    min_record_body_chars: int = field(default_factory=lambda: int(optional_number('MIN_RECORD_BODY_CHARS', 300)))
    # Any page needs at least this much cleaned text to be worth a chunk.
    min_page_chars: int = field(default_factory=lambda: int(optional_number('MIN_PAGE_CHARS', 80)))
    max_results_to_summarize: int = field(default_factory=lambda: int(optional_number('MAX_RESULTS_TO_SUMMARIZE', 5)))
    # Score multiplier for pages older than last season when the query doesn't ask for history.
    # Swept on the golden set 2026-09-25: 0.7–0.8 best (hit@1 93%), 0.6 hurts.
    historical_penalty: float = field(default_factory=lambda: optional_number('SEARCH_HISTORICAL_PENALTY', 0.7))
    # Reuse the previous release's page markdown + embeddings for unchanged content.
    index_incremental: bool = field(default_factory=lambda: optional_string('INDEX_INCREMENTAL', 'true') == 'true')
    # How often the running bot checks the release for a fresher index (0 disables).
    index_refresh_minutes: float = field(default_factory=lambda: optional_number('INDEX_REFRESH_MINUTES', 60))
    index_rate_limit_ms: float = field(default_factory=lambda: optional_number('INDEX_RATE_LIMIT_MS', 375))
    auto_bootstrap_on_missing_index: bool = field(
        default_factory=lambda: optional_string('AUTO_BOOTSTRAP_ON_MISSING_INDEX', 'true') == 'true'
    )
    save_checkpoint_every_batches: int = field(
        default_factory=lambda: int(optional_number('SAVE_CHECKPOINT_EVERY_BATCHES', 10))
    )


@dataclass
class Config:
    slack: SlackConfig = field(default_factory=SlackConfig)
    notion: NotionConfig = field(default_factory=NotionConfig)
    openai: OpenAIConfig = field(default_factory=OpenAIConfig)
    groq: GroqConfig = field(default_factory=GroqConfig)
    hunter: HunterConfig = field(default_factory=HunterConfig)
    sponsorship: SponsorshipConfig = field(default_factory=SponsorshipConfig)
    ops_tasks: OpsTasksConfig = field(default_factory=OpsTasksConfig)
    benbuys: BenbuysConfig = field(default_factory=BenbuysConfig)
    race: RaceConfig = field(default_factory=RaceConfig)
    price_check: PriceCheckConfig = field(default_factory=PriceCheckConfig)
    arrivals: ArrivalsConfig = field(default_factory=ArrivalsConfig)
    gdrive: GDriveConfig = field(default_factory=GDriveConfig)
    github: GitHubConfig = field(default_factory=GitHubConfig)
    app: AppConfig = field(default_factory=AppConfig)


config = Config()


def has_openai() -> bool:
    return bool(config.openai.api_key)


def has_groq() -> bool:
    return bool(config.groq.api_key)


def has_drive() -> bool:
    return bool(config.gdrive.service_account_json or config.gdrive.service_account_file)


def has_hunter() -> bool:
    return bool(config.hunter.api_key)
