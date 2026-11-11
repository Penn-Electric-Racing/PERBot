"""Shared types + the closed vocabularies for the Sponsorship module.

The enum tuples below MUST stay in sync with the live Notion select/multi-select options in
the Prospect Bank and Pipeline data sources. The LLM classifier and the Notion writer both
validate against these, so a drift here silently drops values on write. Update these if the
Notion options change.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from .fsae_ties import FsaeScan
    from .scoring import SponsorScores

# Tier is no longer a stored/LLM value — it's a Notion formula derived from Priority (see
# scoring.py + the `Tier` formula on the Prospect Bank). These labels are the formula's
# possible outputs, kept here for reference only.
TIERS = ('Tier 1', 'Tier 2', 'Tier 3')
Tier = Literal['Tier 1', 'Tier 2', 'Tier 3']

SPONSOR_TYPES = ('Cash', 'In-Kind')
SponsorType = Literal['Cash', 'In-Kind']

CHANNELS = ('Vendor', 'Alumni employer', 'Competitor sponsor', 'Category/TAM', 'Local/Regional', 'Inbound', 'Other')
Channel = str

CATEGORIES = (
    'Aerodynamics',
    'Chassis/DI',
    'Drivetrain',
    'Suspension',
    'Accumulator',
    'Vehicle Dynamics',
    'Electrical Hardware',
    'Manufacturing',
    'Software/CAD',
    'General',
    'Business/Ops',
    'Team-wide',
)
Category = str

# Bank Status / Relationship — plain enrichment writes Available / New (see guardrails).
BANK_STATUSES = ('Available', 'Claimed', 'Graduated', 'Dead')
BankStatus = Literal['Available', 'Claimed', 'Graduated', 'Dead']
RELATIONSHIPS = ('New', 'Returning', 'Lapsed')

# Pipeline Stage — the 5-stage model.
STAGES = ('Prospect', 'Contacted', 'In talks', 'Won', 'Lost')
Stage = Literal['Prospect', 'Contacted', 'In talks', 'Won', 'Lost']

# How a Won deal delivered its value — set by `/sponsor won <co> <amt> [kind]` (or in Notion),
# shown in the win post headline. Distinct from `Type` (what a company would most naturally
# give): a discount is recorded as the value it saved us.
WON_KINDS = ('Cash donation', 'In-kind donation', 'Valued discount')
WonKind = Literal['Cash donation', 'In-kind donation', 'Valued discount']

# Why a deal was Lost: the Pipeline `Loss reason` select. The labels match the sponsor
# heatmap's categories so next season's table lines up with last season's. "No response" is
# set by PERBot (the Wednesday "gone cold" check). The rest are a tap after Lost, and all of
# them are optional.
LOSS_REASONS = (
    'No response',
    'Replied, then went quiet',
    "Policy: doesn't sponsor teams like ours",
    'Sent to a form, application or another team',
    'No budget or capacity right now',
    'Regular price only, no discount',
    "Couldn't do the work we needed",
    'Bounced or wrong contact',
)
LossReason = str


@dataclass
class CompanyClassification:
    """The structured JSON the LLM is forced to return. Contact data is deliberately NOT part
    of this — the LLM never invents contacts (guardrail); those come only from Hunter."""

    fit_reason: str
    suggested_angle: str
    categories: list[Category]
    type: SponsorType
    channel: Channel
    # The three AI-seeded priority sub-scores (0–3 each). Feed the Notion matrix formulas (see
    # scoring.py). The two human sub-scores — Contact strength and Sponsors other teams — are
    # NOT here: the LLM never guesses who we know or a team's rival ties (guardrail), so those
    # stay blank until a human sets them.
    market_fit: int
    value_band: int
    category_need: int


@dataclass
class NotionUser:
    """A Notion workspace user, for bridging DRI persons to Slack identities."""

    id: str
    name: str
    email: str | None = None


@dataclass
class HunterContact:
    """A verified contact from Hunter — the ONLY source of contact data."""

    name: str
    email: str
    # Hunter deliverability verification status, e.g. "valid" | "accept_all" | "unknown".
    verification_status: str
    # 0–100 Hunter confidence score.
    confidence: float


@dataclass
class BankLeadRow:
    """A parsed Prospect Bank row (the subset needed to claim/graduate/rank/draft it)."""

    id: str
    url: str
    company: str
    status: str | None
    type: SponsorType
    categories: list[Category]
    # Canonical https://<domain> from enrichment — lets /sponsor email re-ground on the homepage.
    domain: str
    # The enrichment's stored reasoning — the seed material for the draft's fit paragraph.
    fit_reason: str
    suggested_angle: str
    contact: HunterContact | None
    # True if it already has a linked Pipeline deal (already graduated).
    has_pipeline_deal: bool
    # The five priority sub-scores (0–3, None when unscored) — see scoring.py.
    scores: SponsorScores
    # Someone at the company has verified FSAE/Formula Student history (fsae_ties.py) — ranks first.
    fsae_ties: bool
    # Date the FSAE-ties scan last ran on this row; None = never scanned.
    fsae_scanned_at: str | None


@dataclass
class PipelineRow:
    """A parsed Pipeline deal row (subset of properties the commands + jobs use)."""

    id: str
    url: str = ''
    company: str = ''
    stage: Stage | None = None
    won_kind: WonKind | None = None
    # Notion user IDs of the DRI(s).
    dri_user_ids: list[str] = field(default_factory=list)
    deal_value: float | None = None
    received: float | None = None
    last_contact: str | None = None
    next_action: str | None = None
    next_action_date: str | None = None
    notes: str = ''
    # ISO datetime the Notion page was created — when the deal entered the Pipeline.
    created_time: str = ''
    # ISO datetime the deal first left Prospect (→ Contacted / In talks / Won) = outreach sent.
    # Stamped ONLY by a deliberate act in Slack — `/sponsor stage` / `/sponsor won` / a stage
    # button. Editing Stage in Notion leaves this None on purpose (a row saying "Contacted"
    # isn't evidence anyone sent an email), so such a deal earns no quota credit until someone
    # runs the command. None while still Prospect (or Lost from it). The weekly quota audit
    # credits the deal's DRI(s) in the week of this stamp.
    contacted_at: str | None = None
    # Why it was Lost (`Loss reason`); None when not Lost or nobody said.
    loss_reason: LossReason | None = None
    # The Bank row this deal graduated from (`Bank source` relation), if any.
    bank_source_id: str | None = None
    # YYYY-MM-DD the Wednesday DM last asked about this deal going cold (`Cold asked`).
    cold_asked_at: str | None = None
    # YYYY-MM-DD the Wednesday DM asked "sent it, or release it?" about this claim (`Release asked`).
    release_asked_at: str | None = None


@dataclass
class QuotaRosterMember:
    """An active row of the 👥 Ops Quota Roster — a member held to the weekly quota."""

    # Display name from the roster's title (humans maintain it; Notion display names can be blank/emails).
    name: str
    # The member's Notion user ID — matched against Pipeline DRI.
    notion_user_id: str


@dataclass
class QuotaAuditResult:
    """One member's result for one audit week — what gets written to 📋 Weekly Quota Audit."""

    member: QuotaRosterMember
    # YYYY-MM-DD (ET) — window opens Sat 10:00 ET on this date.
    week_start_iso: str
    # YYYY-MM-DD (ET) — window closes Sat 10:00 ET on this date; the audit key.
    week_end_iso: str
    # This member's deals whose `Contacted at` (first move out of Prospect) falls inside the window.
    deals: list[PipelineRow]
    quota: float
    met: bool


@dataclass
class BankRowInput:
    """Everything needed to write one Prospect Bank row."""

    company: str
    # Canonical https://<domain> — the dedupe key.
    domain: str
    classification: CompanyClassification
    contact: HunterContact | None
    # True when Hunter confidence is low or the email is unverified → surfaced in Notes.
    needs_review: bool
    review_reason: str | None = None
    # Defaults to 'Available'. A directed add with an assignee writes 'Graduated'.
    status: BankStatus | None = None
    # Notion user IDs to set on 'Claimed by' (directed add).
    claimed_by_notion_ids: list[str] | None = None
    # FSAE-ties scan result; omitted when the scan failed (row stays unscanned).
    fsae: FsaeScan | None = None


@dataclass
class PipelineDealInput:
    """Everything needed to open one Pipeline deal (directed add / graduation)."""

    bank_page_id: str
    company: str
    dri_notion_ids: list[str]
    type: SponsorType
    categories: list[Category]
    contact: HunterContact | None
    # Free-text next step (e.g. "Send first outreach — reduced-cost PCB fab").
    next_action: str
    # ISO date the next action is due (feeds the Wednesday stale DM).
    next_action_date_iso: str


@dataclass
class AssignmentInfo:
    """Assignment outcome attached to an EnrichResult when a directed add ran."""

    # Display labels of the assigned DRIs.
    assignees: list[str]
    # Mentions we couldn't resolve to a Notion user (assignment skipped for them).
    unresolved: list[str]
    # URL of the created Pipeline deal, if one was opened.
    deal_url: str | None = None


@dataclass
class EnrichResult:
    """Result of an enrichment run, for the CLI + Slack confirmation message.

    `deduped`: when the domain already exists in the Bank we short-circuit before classifying /
    spending a Hunter credit, so classification/contact/fsae are absent on that branch."""

    deduped: bool
    company: str
    domain: str
    # URL of the newly created (or, when deduped, the pre-existing) Bank page.
    bank_page_url: str
    # deduped only: the existing lead was already a Pipeline deal before this add.
    already_deal: bool = False
    classification: CompanyClassification | None = None
    contact: HunterContact | None = None
    # None when the FSAE-ties scan failed (the row is left for the backfill to retry).
    fsae: FsaeScan | None = None
    needs_review: bool = False
    review_reason: str | None = None
    assignment: AssignmentInfo | None = None
