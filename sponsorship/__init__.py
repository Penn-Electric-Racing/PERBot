"""Sponsorship: the Prospect Bank and Pipeline in Notion, `/sponsor` in Slack, the deal cards'
buttons, and the weekly jobs (in jobs/).

  feature.py                Sponsorship: the `/sponsor` command
  views.py                  DealView: the deal cards' buttons and forms
  slack.py                  the `/sponsor` subcommands
  notion.py                 SponsorNotion: the Prospect Bank and Pipeline
  models.py                 shared types and vocabularies
  deal_blocks.py            Block Kit for deal lists
  quota.py                  the weekly quota: audit window, results, standings
  wins.py                   win posts (announce_won_now)
  next_actions.py           the Next actions PERBot writes
  scoring.py                the priority model
  match.py                  picking one lead / deal out of a title search
  discovery.py              `/sponsor find` and `/sponsor scout`
  enrich_company.py         the enrichment pipeline
  classify.py               LLM sponsorship-fit classification
  homepage.py               fetching a company homepage
  domain.py                 domain handling for enrichment
  hunter.py                 Hunter.io contacts
  fsae_ties.py              FSAE-ties detector
  email_draft.py            outreach drafts for `/sponsor email`

Run with `python -m`:

  discovery_cli.py          `python -m sponsorship.discovery_cli`
  draft_cli.py              `python -m sponsorship.draft_cli`
  enrich_cli.py             `python -m sponsorship.enrich_cli`
  fix_next_actions_cli.py   `python -m sponsorship.fix_next_actions_cli`
  fsae_scan_cli.py          `python -m sponsorship.fsae_scan_cli`
"""

from .classify import *
from .deal_blocks import *
from .discovery import *
from .domain import *
from .email_draft import *
from .enrich_company import *
from .feature import *
from .fsae_ties import *
from .homepage import *
from .hunter import *
from .match import *
from .models import *
from .next_actions import *
from .notion import *
from .quota import *
from .scoring import *
from .slack import *
from .views import *
from .wins import *

__all__ = (
    'SYSTEM_PROMPT', 'classify_company_fit', 'DEAL_ACTION_IDS', 'DEAL_STAGE_ACTION_RE',
    'DEAL_COLD_ACTION_RE', 'DEAL_LOSS_ACTION_RE', 'APPLY_VIA_MODAL_ID', 'LOSS_BUTTON_LABELS',
    'loss_reason_for_action', 'WON_MODAL_ID', 'TOUCH_MODAL_ID', 'DealButtonValue',
    'encode_deal_value', 'decode_deal_value', 'deal_section_id', 'deal_actions_id',
    'default_deal_line', 'buttons_for', 'loss_reason_buttons', 'cold_deal_blocks',
    'stale_claim_blocks', 'finalize_deal_blocks', 'deal_blocks', 'deal_list_blocks',
    'replace_deal_blocks', 'RATE_LIMIT_RETRIES', 'DEFAULT_WAIT_S', 'chat_json', 'ProspectMatch',
    'FIND_LIMIT', 'SHORTLIST_LIMIT', 'FIND_REASON_CHARS', 'SHORTLIST_BUDGET_CHARS',
    'SHORTLIST_SYSTEM_PROMPT', 'RANK_SYSTEM_PROMPT', 'read_roster_numbers',
    'find_matching_prospects', 'ScoutVerdict', 'ScoutCandidate', 'ScoutResult',
    'SCOUT_ASK_LIMIT', 'FETCH_CONCURRENCY', 'SNIPPET_CHARS', 'KNOWN_DOMAINS_IN_PROMPT',
    'SCOUT_SYSTEM_PROMPT', 'VERIFY_SYSTEM_PROMPT', 'scout_companies', 'extract_hostname',
    'looks_like_domain', 'to_canonical_url', 'PERSONALIZED_MARKER', 'MAX_PARAGRAPH_CHARS',
    'DraftEmailResult', 'PARAGRAPH_SYSTEM_PROMPT', 'MAX_ASK_CHARS', 'draft_outreach_email',
    'FIRST_OUTREACH_DAYS', 'EnrichOptions', 'DomainResolutionError', 'OK_STATUSES',
    'MIN_CONFIDENCE', 'enrich_company', 'Sponsorship', 'FSAE_PATTERN', 'TEAM_PAGE_HINT',
    'FALLBACK_PATHS', 'MAX_LINKED_PAGES', 'SNIPPET_RADIUS', 'MAX_SNIPPETS', 'FsaePerson',
    'FsaeCompanyMention', 'FsaeScan', 'Snippet', 'find_team_page_links', 'extract_snippets',
    'verify_labels', 'LABEL_PROMPT', 'scan_fsae_ties', 'format_fsae_evidence', 'MAX_TEXT_CHARS',
    'FETCH_TIMEOUT_S', 'strip_html', 'fetch_html', 'fetch_company_text', 'HUNTER_BASE',
    'HUNTER_TIMEOUT_S', 'ROLE_PRIORITY', 'find_contact_by_domain', 'CompanyLookup',
    'resolve_by_company', 'T', 'NameMatch', 'normalize_name', 'pick_by_name', 'pick_live_deal',
    'TIERS', 'Tier', 'SPONSOR_TYPES', 'SponsorType', 'CHANNELS', 'Channel', 'CATEGORIES',
    'Category', 'BANK_STATUSES', 'BankStatus', 'RELATIONSHIPS', 'STAGES', 'Stage', 'WON_KINDS',
    'WonKind', 'LOSS_REASONS', 'LossReason', 'CompanyClassification', 'HunterContact',
    'BankLeadRow', 'PipelineRow', 'QuotaRosterMember', 'QuotaAuditResult', 'BankRowInput',
    'PipelineDealInput', 'AssignmentInfo', 'EnrichResult', 'FIRST_OUTREACH_ACTION',
    'FOLLOW_UP_ACTION', 'CHECK_REPLY_ACTION', 'FOLLOW_UP_DAYS', 'COLD_AFTER_DAYS',
    'is_auto_next_action', 'NextActionChange', 'next_action_for_stage',
    'next_action_after_touch', 'backfill_next_action', 'next_action_properties', 'BankPageRef',
    'DRAFT_EMAIL_MARKER', 'SPECIFIC_ASK_MARKER', 'read_title', 'read_rich_text', 'read_select',
    'read_number', 'read_date', 'read_people_ids', 'FSAE_TIES_PROP', 'FSAE_EVIDENCE_PROP',
    'FSAE_SCANNED_PROP', 'CONTACTED_AT_PROP', 'LOSS_REASON_PROP', 'COLD_ASKED_PROP',
    'APPLY_VIA_PROP', 'RELEASE_ASKED_PROP', 'CONTACTED_STAGES', 'parse_bank_row',
    'parse_pipeline_row', 'ACTIVE_STAGE_FILTER', 'SponsorNotion', 'AUDIT_HOUR_ET',
    'BULK_STAMP_MIN', 'AuditWindow', 'bulk_stamp_instants', 'audit_window',
    'current_audit_window', 'compute_quota_results', 'NO_REPLY_NO_FOLLOWUP_PCT',
    'FOLLOW_UP_MAX_AGE_DAYS', 'follow_up_gap_deals', 'build_follow_up_gap_line', 'fmt_date',
    'build_quota_post', 'format_quota_standing', 'SponsorScores', 'HIGH_FIT', 'HIGH_IMPACT',
    'TIER1_PRIORITY', 'TIER2_PRIORITY', 'fit_score', 'impact_score', 'priority_score',
    'quadrant', 'tier', 'rank_key', 'USAGE', 'HEATMAP_URL', 'HEATMAP_AS_OF', 'heatmap_text',
    'ParsedAdd', 'FIELD_BOUNDARY', 'parse_add', 'resolve_assignees', 'resolve_single_bank_row',
    'resolve_single_deal', 'EMAIL_SLACK_PREVIEW_CHARS', 'parse_email_arg', 'parse_log',
    'SCORE_ALIASES', 'SCORE_PAIR_RE', 'parse_score', 'SCORE_LABELS', 'RANK_LIMIT',
    'WON_KIND_RE', 'ParsedWon', 'parse_won', 'parse_stage', 'LeaderboardRow',
    'compute_leaderboard', 'MEDALS', 'LEADERBOARD_LIMIT', 'handle_command', 'ModalMeta',
    'STAGE_FOR_ACTION', 'STAGE_EMOJI', 'COLD_WAIT_DAYS', 'LOSS_REASON_FOLLOW_UP', 'NOT_YOURS',
    'DealView', 'win_marker', 'win_claim_key', 'fmt_usd', 'total_raised',
    'resolve_dri_mentions', 'latest_won_note', 'announce_win_if_new', 'announce_won_now',
)
