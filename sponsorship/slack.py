"""Slack surface for the sponsorship module: the `/sponsor` command (add / claim / ask / email / find /
scout / log / won / stage / score / rank / leaderboard / quota / me / heatmap). Registered from
app.py via register_sponsor_commands.

Drafting guardrail: `/sponsor email` fills the team's own template; the LLM writes only the fit
paragraph, the draft is never auto-sent, and a human reviews it first.
"""
from __future__ import annotations

import dataclasses
import math
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, NamedTuple

from slack_bolt import App
from slack_sdk import WebClient

from config import config
from utils.clock import to_iso
from utils.logger import logger
from utils.text import js_number, round2
from sponsorship.dates import iso_days_from_now_et, today_iso_et
from sponsorship.deal_blocks import DealButtonValue, deal_list_blocks, loss_reason_buttons
from sponsorship.discovery import find_matching_prospects, scout_companies
from sponsorship.domain import extract_hostname, looks_like_domain
from sponsorship.email_draft import draft_outreach_email
from sponsorship.enrich_company import DomainResolutionError, EnrichOptions, enrich_company
from sponsorship.identity import index_notion_users, resolve_slack_handles, slack_user_to_notion_id
from sponsorship.jobs.quota_audit import compute_quota_results, current_audit_window, format_quota_standing
from sponsorship.jobs.win_post import announce_won_now, fmt_usd, total_raised
from sponsorship.match import NameMatch, pick_by_name, pick_live_deal
from sponsorship.models import CATEGORIES, STAGES, BankLeadRow, Category, EnrichResult, PipelineDealInput, PipelineRow, Stage, WonKind
from sponsorship.next_actions import FIRST_OUTREACH_ACTION
from sponsorship.notion import SponsorNotion
from sponsorship.scoring import SponsorScores, fit_score, impact_score, priority_score, quadrant, rank_key

notion = SponsorNotion()

Respond = Callable[..., Any]

USAGE = '\n'.join(
    [
        '*`/sponsor` commands:*',
        '• `/sponsor add <company or url>` — research a company into the Prospect Bank',
        '• `/sponsor add <company> for <ask> contact: <name> <email> @person` — research + set a known contact + assign a deal',
        '• `/sponsor claim <company> [@person]` — take an existing Bank lead as a deal you own',
        '• `/sponsor email <company> [for <ask>]` — draft outreach from the team template + an AI fit paragraph (review before sending)',
        '• `/sponsor ask <company> - <what we want>` — set the 🎯 specific ask a draft includes verbatim (paste detailed specs under the toggle in Notion)',
        '• `/sponsor log <company> - <note>` — log a manual touch on a deal',
        '• `/sponsor won <company> <amount> [cash|in-kind|discount] [note]` — mark a deal Won + post it to #operations',
        '• `/sponsor stage <company> <stage>` — move a deal (Prospect / Contacted / In talks / Won / Lost)',
        '• `/sponsor score <company> contact:<0-3> teams:<0-3>` — set a prospect’s human scores (also `market:`/`value:`/`need:`)',
        '• `/sponsor rank [category]` — top prospects by Priority (Fit × Impact), with their quadrant; 🏁 FSAE-alumni ties first',
        '• `/sponsor find <what we need>` — search the *unclaimed* Bank for leads matching a need (e.g. `find cooling jackets for our motor`)',
        '• `/sponsor scout <what we need>` — hunt for *new* companies not in the Bank yet (AI-suggested, homepage-checked; add keepers with `/sponsor add`)',
        '• `/sponsor leaderboard` — who’s raised what: $ won + active deals per person (only you see it)',
        '• `/sponsor quota` — where you (and the team) stand on this week’s quota (3 deals moved to Contacted) before Saturday’s audit',
        '• `/sponsor me` — show your active deals + next actions',
        '• `/sponsor heatmap` — last season’s sponsor heatmap: what goes with a reply or a deal, and why companies said no',
    ]
)

# The sponsor heatmap (PER_sponsor_heatmap.html), hosted as a page. It's built by hand from the
# team's sponsorship email, not from Notion, so it's a snapshot: update the date when the page is
# rebuilt. The link opens only for people the page has been shared with.
HEATMAP_URL = 'https://claude.ai/artifact/MYtapBxCSWs2vZQG6eeh9W'
HEATMAP_AS_OF = 'Sep 28, 2026'


def heatmap_text() -> str:
    return '\n'.join(
        [
            f':bar_chart: *<{HEATMAP_URL}|Sponsor heatmap>* (data as of {HEATMAP_AS_OF})',
            'What tends to go with a reply, a deal or a renewal, by company size and outreach channel, plus why companies didn’t give anything.',
            '_Can’t open it? Ask Arjun to share the page with you._',
        ]
    )


def _eph(respond: Respond, text: str, blocks: list[dict[str, Any]] | None = None) -> None:
    if blocks is None:
        respond(response_type='ephemeral', text=text)
    else:
        respond(response_type='ephemeral', text=text, blocks=blocks)


def _parallel(*fns: Callable[[], Any]) -> list[Any]:
    """Run independent Notion reads at once (each is a paginated HTTP query)."""
    with ThreadPoolExecutor(max_workers=len(fns)) as pool:
        futures = [pool.submit(fn) for fn in fns]
        return [f.result() for f in futures]


# --- Parsing ------------------------------------------------------------------

# Slack encodes mentions in command text as `<@U012ABC>` or `<@U012ABC|handle>`.
MENTION_RE = re.compile(r'<@([A-Z0-9]+)(?:\|[^>]+)?>')
EMAIL_RE = re.compile(r'[^\s<>]+@[^\s<>]+\.[^\s<>]+')


def unwrap_slack_links(text: str) -> str:
    """Slack auto-links URLs/emails in slash-command text — strip the `<…|…>` wrappers."""
    text = re.sub(r'<mailto:([^|>]+)(?:\|[^>]*)?>', r'\1', text, flags=re.I)
    return re.sub(r'<(https?://[^|>]+)(?:\|[^>]*)?>', r'\1', text, flags=re.I)


# A plain-text "@handle" (NOT a real Slack mention) — anchored to whitespace/start so it never
# matches the "@" inside an email. Real mentions are `<@U…>` (see MENTION_RE).
PLAIN_HANDLE_RE = re.compile(r'(^|\s)@([a-z0-9._-]+)', re.I)


def extract_plain_handles(text: str) -> tuple[list[str], str]:
    """Pull out plain-text @handles (typed, not picked from the menu) and remove them → (handles, cleaned)."""
    handles = [m.group(2) for m in PLAIN_HANDLE_RE.finditer(text)]
    cleaned = re.sub(r'\s+', ' ', PLAIN_HANDLE_RE.sub(r'\1', text)).strip()
    return handles, cleaned


def _take_mentions(text: str) -> tuple[list[str], str]:
    """Real Slack mentions → (deduped user ids, text with each mention replaced by a space)."""
    ids: list[str] = []

    def grab(m: re.Match[str]) -> str:
        ids.append(m.group(1))
        return ' '

    work = MENTION_RE.sub(grab, text)
    return list(dict.fromkeys(ids)), work


@dataclass
class ParsedAdd:
    company: str
    known_ask: str = ''
    assignee_slack_ids: list[str] = field(default_factory=list)
    # Plain-text @handles that weren't real mentions — resolved via the directory or reported.
    plain_handles: list[str] = field(default_factory=list)
    contact_name: str = ''
    contact_email: str = ''


# Words that mark the end of the company name and the start of metadata. Lets people write
# naturally ("Jane Street, DRI is @X contact is Y") instead of a rigid grammar.
FIELD_BOUNDARY = re.compile(r',|\bfor\b|\bcontact\b|\bdri\b|\bowner\b|\bassign(?:ed)?\b', re.I)


def _leading_company(text: str) -> str:
    """The leading company name = text up to the first metadata boundary (comma/keyword)."""
    b = FIELD_BOUNDARY.search(text)
    head = text[: b.start()] if b else text
    head = re.sub(r'[,\s]+$', '', head)  # trailing space/comma first…
    head = re.sub(r'^["\']+|["\']+$', '', head)  # …then surrounding quotes
    return head.strip()


def parse_add(arg: str) -> ParsedAdd:
    """Forgiving parser for `/sponsor add`. Handles both the structured form
    (`jlcpcb.com for reduced-cost fab contact: Chloe Wang chloe@jlcpcb.com @arjun`) and natural
    phrasing (`Jane Street, DRI is @Arjun contact is Stephanie, s@jane.com`). Mentions, emails, the
    `for <ask>`, and `contact <is|:> <name>` may appear anywhere; the company is whatever leads
    before the first metadata boundary."""
    # 1. Real Slack mentions anywhere → assignees (DRI).
    assignee_slack_ids, work = _take_mentions(unwrap_slack_links(arg))

    # 2. Plain-text @handles (typed, not real mentions) → reported + removed.
    plain_handles, work = extract_plain_handles(work)

    # 3. Email anywhere → the contact email.
    email_match = EMAIL_RE.search(work)
    contact_email = email_match.group(0) if email_match else ''
    if email_match:
        work = work.replace(email_match.group(0), ' ', 1)
    work = re.sub(r'\s+', ' ', work).strip()

    # 4. Known ask: text after "for", up to the next metadata word.
    known_ask = ''
    for_match = re.search(r'\bfor\s+(.+?)(?=,?\s*\b(?:contact|dri|owner|assign)\b|$)', work, re.I)
    if for_match:
        known_ask = re.sub(r'[,\s]+$', '', for_match.group(1)).strip()

    # 5. Contact name: after "contact is / contact: / contact =", up to the next word.
    contact_name = ''
    contact_match = re.search(r'\bcontact(?:\s+is|\s*[:=])\s*(.+?)(?=,?\s*\b(?:for|dri|owner|assign)\b|$)', work, re.I)
    if contact_match:
        contact_name = re.sub(r'[,\s]+$', '', re.sub(r'[<>]', '', contact_match.group(1))).strip()

    # 6. Company = the leading chunk before any metadata boundary.
    return ParsedAdd(
        company=_leading_company(work),
        known_ask=known_ask,
        assignee_slack_ids=assignee_slack_ids,
        plain_handles=plain_handles,
        contact_name=contact_name,
        contact_email=contact_email,
    )


def _format_add_result(result: EnrichResult) -> str:
    if result.deduped:
        if result.assignment and result.assignment.deal_url:
            # Was already in the Bank, but we graduated it to a deal for the assignee.
            return (
                f"✅ *{result.company}* was already in the Bank — claimed it for {', '.join(result.assignment.assignees)} "
                f'→ <{result.assignment.deal_url}|Pipeline deal> (Prospect).'
            )
        base = f'↩︎ *{result.company}* is already in the Bank. <{result.bank_page_url}|Open row>'
        host = extract_hostname(result.domain) or result.company
        if result.already_deal:
            return (
                f"{base}\n• It's already a Pipeline deal — update it with `/sponsor stage {host} <stage>` "
                f'or `/sponsor log {host} - <note>`.'
            )
        return f"{base}\n• Nobody's claimed it yet — `/sponsor claim {host}` makes it your deal."

    c = result.classification
    assert c is not None
    contact_line = '_none found_'
    if result.contact:
        ct = result.contact
        meta = (
            'provided by you'
            if ct.verification_status == 'provided'
            else f'{ct.verification_status}, confidence {js_number(ct.confidence)}'
        )
        contact_line = f"{ct.name or '(no name)'} <{ct.email or 'no email'}> — {meta}"

    # AI seeds three sub-scores; the two human sub-scores are still blank, so this Priority is
    # provisional (Fit counts Market fit only until someone scores contact).
    seeded = SponsorScores(market_fit=c.market_fit, value_band=c.value_band, category_need=c.category_need)
    lines = [
        f'✅ Added *{result.company}* to the Prospect Bank. <{result.bank_page_url}|Open row>',
        f"• *Type:* {c.type}   *Channel:* {c.channel}   *Category:* {', '.join(c.categories)}",
        f'• *Scores (AI):* market {c.market_fit}/3 · value {c.value_band}/3 · need {c.category_need}/3  →  '
        f'*Priority so far:* {js_number(priority_score(seeded))}',
        '• _Set *Contact strength* + *Sponsors other teams* (0–3) in Notion to finish the score._',
        f'• *Why:* {c.fit_reason}',
    ]
    if c.suggested_angle:
        lines.append(f'• *Angle:* {c.suggested_angle}')
    lines.append(f'• *Contact:* {contact_line}')
    if result.fsae and result.fsae.ties:
        people = ', '.join(p.name for p in result.fsae.people)
        lines.append(
            f'• 🏁 *FSAE ties:* {people} (Formula SAE / Formula Student history). This row ranks first in `/sponsor rank`.'
        )
    if result.needs_review:
        lines.append(f'• ⚠️ *Needs review:* {result.review_reason}')
    if result.assignment and result.assignment.deal_url:
        lines.append(
            f"• *Assigned:* {', '.join(result.assignment.assignees)} → <{result.assignment.deal_url}|Pipeline deal> (Prospect)"
        )
    if result.assignment and result.assignment.unresolved:
        lines.append(
            f"• ⚠️ Couldn't match {', '.join(result.assignment.unresolved)} to a Notion user — assign the DRI in Notion."
        )
    return '\n'.join(lines)


class ResolvedAssignees(NamedTuple):
    notion_ids: list[str]
    labels: list[str]
    unresolved: list[str]


def resolve_assignees(client: WebClient, slack_ids: list[str], plain_handles: list[str] | None = None) -> ResolvedAssignees:
    """Resolve assignees → Notion user IDs. Takes real-mention Slack IDs AND plain-text @handles
    (Slack sends blue-chip mentions as plain text unless the command escapes links); handles are
    looked up in the Slack directory first. Email-first, name fallback."""
    handle_ids, handle_unresolved = resolve_slack_handles(client, plain_handles or [])
    all_slack_ids = list(dict.fromkeys([*slack_ids, *handle_ids]))

    notion_ids: list[str] = []
    labels: list[str] = []
    unresolved = [f'@{h}' for h in handle_unresolved]
    if not all_slack_ids:
        return ResolvedAssignees(notion_ids, labels, unresolved)

    index = index_notion_users(notion.list_notion_users())
    for slack_id in all_slack_ids:
        notion_id = slack_user_to_notion_id(client, slack_id, index)
        if notion_id:
            notion_ids.append(notion_id)
            labels.append(f'<@{slack_id}>')
        else:
            unresolved.append(f'<@{slack_id}>')
    return ResolvedAssignees(notion_ids, labels, unresolved)


def _handle_add(client: WebClient, respond: Respond, arg: str) -> None:
    parsed = parse_add(arg)
    if not parsed.company:
        _eph(
            respond,
            'Usage: `/sponsor add <company or url> [for <your ask>] [contact: <name> <email>] [@person]`\n'
            'Example: `/sponsor add Jane Street for cash sponsorship contact: Stephanie Grassulo sgrassulo@janestreet.com @you`',
        )
        return

    try:
        assignees = resolve_assignees(client, parsed.assignee_slack_ids, parsed.plain_handles)
        result = enrich_company(
            parsed.company,
            EnrichOptions(
                notion=notion,
                known_ask=parsed.known_ask or None,
                assignee_notion_ids=assignees.notion_ids,
                assignee_labels=assignees.labels,
                unresolved_assignees=assignees.unresolved,
                manual_contact=(parsed.contact_name, parsed.contact_email)
                if parsed.contact_name or parsed.contact_email
                else None,
            ),
        )
        _eph(respond, _format_add_result(result))
    except DomainResolutionError as err:
        _eph(respond, f'✗ {err}')
    except Exception as err:
        logger.error('/sponsor add failed', err)
        _eph(respond, '✗ Enrichment failed. Check the PERBot logs and try again.')


# --- /sponsor me -------------------------------------------------------------


def _format_deal_line(row: PipelineRow) -> str:
    stage = row.stage or 'Prospect'
    nxt = f' — Next: {row.next_action}' if row.next_action else ''
    due = f' (due {row.next_action_date})' if row.next_action_date else ''
    return f"• <{row.url}|{row.company or 'Untitled'}> — *{stage}*{nxt}{due}"


def _handle_me(client: WebClient, respond: Respond, slack_user_id: str) -> None:
    notion_id = slack_user_to_notion_id(client, slack_user_id, index_notion_users(notion.list_notion_users()))
    if not notion_id:
        _eph(
            respond,
            "I couldn't match your Slack account to a Notion user (by email or name). Ask an admin to check your Notion access.",
        )
        return

    deals = notion.query_active_deals_for_user(notion_id)
    if not deals:
        _eph(respond, 'You have no active sponsorship deals. 🎉')
        return

    header = f'*Your active deals ({len(deals)}):*'
    text = '\n'.join([header, *(_format_deal_line(d) for d in deals)])
    # Buttons (Contacted / In talks / Won / Lost / Log touch) — handled by actions.py. Slack caps a
    # message at 50 blocks; beyond ~20 deals the rest are listed without buttons.
    with_buttons = deals[:20]
    footer = f'_…and {len(deals) - len(with_buttons)} more — see Notion._' if len(deals) > len(with_buttons) else None
    _eph(respond, text, deal_list_blocks(header, with_buttons, slack_user_id, footer=footer))


# --- /sponsor quota ------------------------------------------------------------


def _handle_quota(client: WebClient, respond: Respond, slack_user_id: str) -> None:
    """Mid-week self-check against the Saturday quota audit: same roster, same window (the one
    ending next Saturday 10am ET), same counting rule (`compute_quota_results`), so what people see
    here is exactly what the audit will post. Ephemeral."""
    window = current_audit_window()
    quota = config.sponsorship.weekly_quota
    members, deals, notion_users = _parallel(
        notion.query_quota_roster,
        lambda: notion.query_deals_edited_since(to_iso(window.start)),
        notion.list_notion_users,
    )
    if not members:
        _eph(respond, 'The Ops Quota Roster has no active members — nothing to check.')
        return
    caller_notion_id = slack_user_to_notion_id(client, slack_user_id, index_notion_users(notion_users))
    results = compute_quota_results(members, deals, window, quota)
    _eph(respond, format_quota_standing(results, window, quota, caller_notion_id))


# --- Bank / deal lookup --------------------------------------------------------


def _query_hostname(query: str) -> str | None:
    """"<https://www.keye.co|www.keye.co>" / "keye.co" → "keye.co"; a plain name → None."""
    return extract_hostname(query) if looks_like_domain(query) else None


def _bank_host(row: BankLeadRow) -> str:
    """The bare hostname a user can type back to pick this row, e.g. "skf.com"."""
    return extract_hostname(row.domain) or ''


def _lookup_bank_rows(query: str) -> NameMatch[BankLeadRow]:
    """Bank rows for a `/sponsor` argument: a URL/domain matches the Domain column (the only thing
    that tells two "SKF" rows apart); a name goes through the title search with
    exact-name-beats-substring (so "Keye" isn't ambiguous with "Hawkeyeind")."""
    host = _query_hostname(query)
    if host:
        rows = notion.find_bank_rows_by_hostname(host)
        if len(rows) == 1:
            return NameMatch('one', row=rows[0])
        return NameMatch('many', rows=rows) if rows else NameMatch('none')
    return pick_by_name(notion.find_bank_rows_by_company(query), query)


def _ambiguous_bank_text(query: str, rows: list[BankLeadRow], subcommand: str) -> str:
    """"Several match" reply that shows each row's domain and how to pick one."""
    lines = []
    for r in rows[:8]:
        host = _bank_host(r)
        state = 'already a deal' if r.has_pipeline_deal or r.status == 'Graduated' else 'unclaimed'
        lines.append(f"• <{r.url}|{r.company}>{f' — {host}' if host else ''} · {state}")
    example = next((h for h in map(_bank_host, rows) if h), None)
    hint = (
        f'\nRe-run with the domain to pick one, e.g. `/sponsor {subcommand} {example}`.'
        if example
        else '\nRename one of them in Notion so the names differ, then re-run.'
    )
    return f"Several Bank leads match *{query}*:\n{chr(10).join(lines)}{hint}"


def resolve_single_bank_row(respond: Respond, raw_query: str, subcommand: str) -> BankLeadRow | None:
    """Find the single Bank prospect for `raw_query` (a name or a domain). Responds itself and
    returns None on zero or ambiguous matches; `subcommand` goes into the retry hint."""
    query = unwrap_slack_links(raw_query).strip()
    match = _lookup_bank_rows(query)
    if match.kind == 'one':
        return match.row
    text = (
        f'No Bank lead matches *{query}*. Add it with `/sponsor add {query}` first.'
        if match.kind == 'none'
        else _ambiguous_bank_text(query, match.rows, subcommand)
    )
    _eph(respond, text)
    return None


def _deal_list(deals: list[PipelineRow]) -> str:
    return '\n'.join(f"• <{d.url}|{d.company}> · {d.stage or 'no stage'}" for d in deals)


def resolve_single_deal(respond: Respond, raw_query: str, subcommand: str) -> PipelineRow | None:
    """Find the single Pipeline deal for `raw_query` (a name or a domain). Shared by log / won /
    stage. A name tries the deal titles first; a domain, or a name with no deal title, goes through
    the Bank row's `Bank source` link, so a deal still resolves when its title differs from what was
    typed. When the company is only in the Bank, the reply says how to claim it instead of "check
    the name". Responds itself and returns None unless exactly one deal is found."""
    query = unwrap_slack_links(raw_query).strip()

    def reply(text: str) -> None:
        _eph(respond, text)
        return None

    if not _query_hostname(query):
        by_title = pick_by_name(notion.find_deals_by_company(query), query)
        deal = pick_live_deal(by_title.rows) if by_title.kind == 'many' else by_title
        if deal.kind == 'one':
            return deal.row
        if deal.kind == 'many':
            return reply(
                f"Several Pipeline deals match *{query}*:\n{_deal_list(deal.rows)}\nUse the exact deal name or the company's domain."
            )

    bank = _lookup_bank_rows(query)
    if bank.kind == 'none':
        return reply(
            f'No Pipeline deal or Bank lead matches *{query}*. Check the spelling, or add it with `/sponsor add <website>`.'
        )
    if bank.kind == 'many':
        return reply(_ambiguous_bank_text(query, bank.rows, subcommand))

    row = bank.row
    assert row is not None
    deal = pick_live_deal(notion.find_deals_for_bank_row(row.id))
    if deal.kind == 'one':
        return deal.row
    claim_ref = _bank_host(row) or row.company
    if deal.kind == 'none':
        return reply(
            f"*{row.company}* is in the Bank but isn't a Pipeline deal yet. <{row.url}|Open row>\n"
            f'Claim it first with `/sponsor claim {claim_ref}` (makes you the DRI), then re-run `/sponsor {subcommand}`.'
        )
    return reply(f'*{row.company}* has several Pipeline deals:\n{_deal_list(deal.rows)}\nUpdate the right one from its Notion page.')


# --- /sponsor email ------------------------------------------------------------

# Slack rejects messages much past 4000 chars; leave headroom for the header lines.
EMAIL_SLACK_PREVIEW_CHARS = 3400


def parse_email_arg(arg: str) -> tuple[str, str]:
    """Parse "Edgerton Gear for machining our planetary gears" → (company, inline ask)."""
    text = unwrap_slack_links(arg).strip()
    m = re.search(r'\s+for\s+', text, re.I)
    if not m:
        return _leading_company(text), ''
    return _leading_company(text[: m.start()]), text[m.end():].strip()


def _handle_email(client: WebClient, respond: Respond, caller_slack_id: str, arg: str) -> None:
    company, ask = parse_email_arg(arg)
    if not company:
        _eph(
            respond,
            'Usage: `/sponsor email <company> [for <ask>]`\nDrafts outreach from the team template with a company-specific '
            'fit paragraph, saves it on the prospect’s Bank page, and gives you the text to copy. A 🎯 specific ask (set via '
            '`/sponsor ask` or the toggle in Notion) is included verbatim. Review before sending.',
        )
        return

    row = resolve_single_bank_row(respond, company, 'email')
    if not row:
        return

    # The sender is the caller: their real name fills [NAME] and the signature.
    sender_name = ''
    try:
        info: Any = client.users_info(user=caller_slack_id)
        user = info.get('user') or {}
        sender_name = (user.get('profile') or {}).get('real_name') or user.get('real_name') or ''
    except Exception as err:
        logger.warn('/sponsor email: users.info failed; leaving the [NAME] placeholder', err)

    result = draft_outreach_email(notion, row, sender_name, ask)

    preview = (
        f'{result.email_text[:EMAIL_SLACK_PREVIEW_CHARS]}\n… (truncated — full draft is in Notion)'
        if len(result.email_text) > EMAIL_SLACK_PREVIEW_CHARS
        else result.email_text
    )
    lines = [
        f'📧 Drafted outreach for *{result.company}* → <{result.draft_url}|Open draft in Notion>',
        ''
        if result.grounded
        else "⚠️ Couldn't fetch their homepage — the fit paragraph leans on stored research only, so read it extra carefully.",
        '🎯 Includes the specific ask (specs copied verbatim — double-check them).' if result.has_ask else '',
        '_AI-assisted draft: the fit paragraph is generated. Review it (and make it yours) before sending._',
        f'```{preview}```',
    ]
    _eph(respond, '\n'.join(x for x in lines if x))


# --- /sponsor ask --------------------------------------------------------------


def parse_log(arg: str) -> tuple[str, str] | None:
    """Parse "Acme Corp - called, they're interested" → (company, note)."""
    m = re.match(r'^(.*?)\s+[-–—:]\s+(.+)$', arg)
    if not m:
        return None
    company, note = m.group(1).strip(), m.group(2).strip()
    return (company, note) if company and note else None


def _handle_ask(respond: Respond, arg: str) -> None:
    parsed = parse_log(unwrap_slack_links(arg))
    if not parsed:
        _eph(
            respond,
            'Usage: `/sponsor ask <company> - <what we want from them>`\n'
            'Example: `/sponsor ask Edgerton Gear - manufacture our planetary gearset (spur gears, 1mm module)`\n'
            'This creates a *🎯 Specific ask* toggle on the prospect’s Bank page — paste detailed multi-line specs under it '
            'in Notion; `/sponsor email` includes them *verbatim* in the draft.',
        )
        return
    company, ask = parsed

    row = resolve_single_bank_row(respond, company, 'ask')
    if not row:
        return

    notion.write_ask_section(row.id, ask)
    _eph(
        respond,
        f'🎯 Set the specific ask on *{row.company}*. <{row.url}|Open row>\n'
        '_For detailed specs (dimensions, materials, tolerances), edit the 🎯 toggle on the page — every line under it goes '
        f'into the draft verbatim. Then run `/sponsor email {row.company}`._',
    )


# --- /sponsor score ----------------------------------------------------------

# Short keys people type → the sub-score they set.
SCORE_ALIASES = {
    'contact': 'contact_strength',
    'teams': 'sponsors_other_teams',
    'sponsors': 'sponsors_other_teams',
    'market': 'market_fit',
    'value': 'value_band',
    'need': 'category_need',
}

# `key[: ]value` where value is a single digit 0–3, e.g. "contact:2" or "teams 3".
SCORE_PAIR_RE = re.compile(r'\b(contact|teams|sponsors|market|value|need)\b\s*[:=]?\s*([0-3])\b', re.I)


def parse_score(arg: str) -> tuple[str, dict[str, int]]:
    """Parse "JLCPCB contact:2 teams:3" → (company, updates). Company = text before the first score pair."""
    updates: dict[str, int] = {}
    first_idx = len(arg)
    for m in SCORE_PAIR_RE.finditer(arg):
        updates[SCORE_ALIASES[m.group(1).lower()]] = int(m.group(2))
        first_idx = min(first_idx, m.start())
    company = re.sub(r'^["\']+|["\']+$', '', re.sub(r'[,\s]+$', '', arg[:first_idx])).strip()
    return company, updates


# Human-friendly label for a sub-score key, for the confirmation message.
SCORE_LABELS = {
    'contact_strength': 'contact',
    'market_fit': 'market',
    'sponsors_other_teams': 'teams',
    'value_band': 'value',
    'category_need': 'need',
}


def _handle_score(respond: Respond, arg: str) -> None:
    company, updates = parse_score(arg)
    if not company or not updates:
        _eph(
            respond,
            'Usage: `/sponsor score <company> contact:<0-3> teams:<0-3>` (also `market:` `value:` `need:`)\n'
            'Example: `/sponsor score JLCPCB contact:2 teams:3` — sets the two human scores and recomputes Priority.',
        )
        return

    row = resolve_single_bank_row(respond, company, 'score')
    if not row:
        return

    notion.update_bank_scores(row.id, updates)
    merged = dataclasses.replace(row.scores, **updates)
    set_str = ' · '.join(f'{SCORE_LABELS[k]} {v}/3' for k, v in updates.items())
    _eph(
        respond,
        f'✅ Scored *{row.company}* — set {set_str}.\n'
        f'• *Fit:* {js_number(fit_score(merged))}/9 · *Impact:* {js_number(impact_score(merged))}/6  →  '
        f'*Priority:* {js_number(priority_score(merged))} {quadrant(merged)}  <{row.url}|Open row>',
    )


# --- /sponsor rank -----------------------------------------------------------


def _resolve_category(arg: str) -> tuple[Category | None, str | None]:
    """Match a free-text arg to a Category (exact, then substring) → (category, unmatched)."""
    q = arg.strip().lower()
    if not q:
        return None, None
    hit = next((c for c in CATEGORIES if c.lower() == q), None) or next((c for c in CATEGORIES if q in c.lower()), None)
    return (hit, None) if hit else (None, arg.strip())


RANK_LIMIT = 10


def _handle_rank(respond: Respond, arg: str) -> None:
    category, unmatched = _resolve_category(arg)
    rows = notion.query_rankable_prospects(category)

    if not rows:
        scope = f' in *{category}*' if category else ''
        _eph(respond, f'No live prospects{scope} to rank yet. Add some with `/sponsor add`.')
        return

    # FSAE ties first, then highest Priority; tie-break on Fit so a warmer lead edges out a colder one.
    ranked = sorted(rows, key=rank_key)[:RANK_LIMIT]

    header = (
        f'*Top prospects — {category}* (by Priority = Fit × Impact)' if category else '*Top prospects* (by Priority = Fit × Impact)'
    )
    lines = []
    for i, r in enumerate(ranked):
        provisional = ' _(unscored)_' if r.scores.contact_strength is None or r.scores.sponsors_other_teams is None else ''
        fsae = '🏁 ' if r.fsae_ties else ''
        lines.append(
            f"{i + 1}. {fsae}<{r.url}|{r.company or 'Untitled'}> — *{js_number(priority_score(r.scores))}* {quadrant(r.scores)}  ·  "
            f'fit {js_number(fit_score(r.scores))}/9 · impact {js_number(impact_score(r.scores))}/6{provisional}'
        )
    if any(r.fsae_ties for r in ranked):
        lines.append(
            '_🏁 = someone there has Formula SAE / Formula Student history (see FSAE evidence in the row). These are listed first._'
        )
    if unmatched:
        lines.insert(0, f'_(couldn\'t match category "{unmatched}" — ranking all categories)_')
    hint = (
        '\n_Rows show low/zero Priority until their Contact strength + Sponsors other teams are scored in Notion._'
        if any(priority_score(r.scores) == 0 for r in ranked)
        else ''
    )
    _eph(respond, '\n'.join([header, *lines]) + hint)


# --- /sponsor find -----------------------------------------------------------


def _handle_find(respond: Respond, arg: str) -> None:
    """Free-text need → matching UNCLAIMED Bank leads (Status = Available), ranked by the LLM with a
    one-line why each. Read-only; claiming is a separate human step."""
    need = arg.strip()
    if not need:
        _eph(
            respond,
            'Usage: `/sponsor find <what we need>`\n'
            'Searches the *unclaimed* Prospect Bank for leads that could supply or fund a need, best fit first.\n'
            'Example: `/sponsor find water cooling jackets for our drivetrain motors`',
        )
        return

    rows = [r for r in notion.query_rankable_prospects() if r.status == 'Available']
    if not rows:
        _eph(respond, 'The Bank has no unclaimed leads to search. Add some with `/sponsor add` or `/sponsor scout`.')
        return

    matches = find_matching_prospects(need, rows)
    if not matches:
        _eph(
            respond,
            f'No unclaimed Bank lead looks like a fit for *{need}* (searched {len(rows)}).\n'
            f'_Try `/sponsor scout {need}` to hunt for new companies._',
        )
        return

    lines = [
        f'{i + 1}. <{m.row.url}|{m.row.company}> — {m.why} _(priority {js_number(priority_score(m.row.scores))} {quadrant(m.row.scores)})_'
        for i, m in enumerate(matches)
    ]
    _eph(
        respond,
        f'*Unclaimed leads matching “{need}”* (searched {len(rows)}):\n'
        + '\n'.join(lines)
        + '\n_Take one with `/sponsor claim <company>` — or `/sponsor scout` to find companies not in the Bank yet._',
    )


# --- /sponsor scout ----------------------------------------------------------


def _handle_scout(respond: Respond, arg: str) -> None:
    """Free-text need → NEW candidate companies (not in the Bank), AI-suggested and then grounded
    against their live homepages. Read-only: writes nothing to Notion and spends no Hunter credits —
    a human adds keepers via `/sponsor add <domain>`."""
    need = arg.strip()
    if not need:
        _eph(
            respond,
            'Usage: `/sponsor scout <what we need>`\n'
            'Suggests *new* companies for a need (not yet in the Bank), each checked against its live website.\n'
            'Example: `/sponsor scout wire EDM job shops that export from China`\n'
            '_Nothing is written anywhere — add the ones you like with `/sponsor add <domain>`._',
        )
        return

    known = notion.query_all_bank_domains()
    result = scout_companies(need, known)
    rejected = result.rejected_count
    suggestions = f"suggestion{'' if rejected == 1 else 's'}"

    if not result.candidates:
        dropped = f' ({rejected} {suggestions} failed the homepage check)' if rejected > 0 else ''
        _eph(
            respond,
            f"Couldn't scout any new companies for *{need}*{dropped}. Try rephrasing the need, or ask around — warm intros "
            'beat cold lists anyway.',
        )
        return

    lines = []
    for c in result.candidates:
        badge = '✓' if c.verdict == 'confirmed' else '⚠️'
        note = ' _(site unreachable — verify before adding)_' if c.verdict == 'unverified' else ''
        lines.append(
            f'{badge} *{c.company}* (<https://{c.hostname}|{c.hostname}>) — {c.why}{note}\n    ↳ `/sponsor add {c.hostname}`'
        )
    dropped_line = f"\n_{rejected} {suggestions} dropped — homepage didn't match the claim._" if rejected > 0 else ''
    _eph(
        respond,
        f'*New sponsor candidates for “{need}”* — ✓ homepage-checked, not yet in the Bank:\n'
        + '\n'.join(lines)
        + dropped_line
        + '\n_Nothing was added to Notion. `/sponsor add <domain>` researches one properly (contact via Hunter) and banks it._',
    )


# --- /sponsor log ------------------------------------------------------------


def _handle_log(respond: Respond, arg: str) -> None:
    parsed = parse_log(arg)
    if not parsed:
        _eph(
            respond,
            'Usage: `/sponsor log <company> - <note>`\nExample: `/sponsor log Altium - called, sending deck Monday`',
        )
        return
    company, note = parsed

    deal = resolve_single_deal(respond, company, 'log')
    if not deal:
        return

    notion.log_touch(deal, note, today_iso_et())
    _eph(respond, f'✅ Logged a touch on <{deal.url}|{deal.company}> and stamped *Last contact* = today.')


# --- /sponsor won -------------------------------------------------------------


def _dollars(raw: str, k_suffix: str | None = None) -> float:
    """Turn a "5,000" / "9k" style token into a number (NaN when there are no digits)."""
    try:
        n = float(raw.replace(',', ''))
    except ValueError:
        return math.nan
    return n * 1000 if k_suffix else n


# Optional win-kind keyword at the start of the note — "cash [donation]", "in-kind [donation]",
# "[valued] discount" — mapped to the Pipeline's `Won kind` select. Word-bounded so notes like
# "cashed the check" aren't misread.
WON_KIND_RE = re.compile(r'^(cash|in-?\s?kind|valued\s+discount|discount)\b(?:\s+donation)?[,:–—-]?\s*', re.I)


def _extract_won_kind(note: str) -> tuple[WonKind | None, str]:
    m = WON_KIND_RE.match(note)
    if not m:
        return None, note
    token = re.sub(r'[\s-]', '', m.group(1).lower())
    kind: WonKind = 'Cash donation' if token == 'cash' else 'In-kind donation' if token == 'inkind' else 'Valued discount'
    return kind, note[m.end():].strip()


@dataclass
class ParsedWon:
    company: str
    amount_usd: float
    note: str
    kind: WonKind | None = None
    # How a computed discount was derived, e.g. "38% of $9,000".
    computed: str | None = None


_WON_PCT_RE = re.compile(r'^(.+?)\s+(\d+(?:\.\d+)?)\s*%[^%$\d]*?\$?\s?([\d,]+(?:\.\d+)?)(k)?\b\s*(?:[-–—:]\s*)?(.*)$', re.I)
_WON_PLAIN_RE = re.compile(r'^(.+?)\s+\$?([\d,]+(?:\.\d+)?)(k)?\b\s*(?:[-–—:]\s*)?(.*)$', re.I)


def parse_won(arg: str) -> ParsedWon | None:
    """Parse the amount for `/sponsor won`. Two forms:
      • plain amount — "$5,000", "5000", "5k"
      • computed discount — "38% of $9k", "38% off 9000", "38% discount on $9,000"
        → the value saved (0.38 × 9000 = $3,420), returned with how it was derived.
    A kind keyword after the amount ("cash" / "in-kind" / "discount") becomes `kind`; a computed
    discount defaults to 'Valued discount' when no kind is typed."""
    t = arg.strip()

    # Percentage/discount form. `[^%$\d]*?` lets filler words sit between the % and the base
    # ("38% discount on cells worth $9000").
    pct = _WON_PCT_RE.match(t)
    if pct:
        company = _leading_company(pct.group(1))
        percent = float(pct.group(2))
        base = _dollars(pct.group(3), pct.group(4))
        amount_usd = round2(percent / 100 * base) if math.isfinite(base) else math.nan
        if company and amount_usd > 0:
            kind, note = _extract_won_kind((pct.group(5) or '').strip())
            # A computed discount is, by definition, a valued discount unless told otherwise.
            return ParsedWon(
                company=company,
                amount_usd=amount_usd,
                note=note,
                kind=kind or 'Valued discount',
                computed=f'{js_number(percent)}% of {fmt_usd(base)}',
            )

    # Plain amount form.
    m = _WON_PLAIN_RE.match(t)
    if not m:
        return None
    company = _leading_company(m.group(1))
    amount = _dollars(m.group(2), m.group(3))
    if not company or not math.isfinite(amount) or amount <= 0:
        return None
    kind, note = _extract_won_kind((m.group(4) or '').strip())
    return ParsedWon(company=company, amount_usd=amount, note=note, kind=kind)


def _handle_won(client: WebClient, respond: Respond, arg: str) -> None:
    parsed = parse_won(arg)
    if not parsed:
        _eph(
            respond,
            'Usage: `/sponsor won <company> <amount> [cash|in-kind|discount] [note]`\nAmount can be a number (`$5,000`, `5k`) '
            'or a discount (`38% of $9k` → $3,420, auto-tagged Valued discount).\nExamples: `/sponsor won Jane Street $5000 cash` '
            '· `/sponsor won Altium 20k in-kind licenses` · `/sponsor won Melasta 38% of $9000 cell discount`',
        )
        return

    deal = resolve_single_deal(respond, parsed.company, 'won')
    if not deal:
        return

    notion.mark_won(deal, parsed.amount_usd, parsed.note, today_iso_et(), parsed.kind)

    # Post to #operations immediately. Same claim as the hourly job → no double-post.
    announced_suffix = ''
    try:
        if announce_won_now(client, notion, deal, parsed.amount_usd, parsed.kind, parsed.note):
            announced_suffix = f' and posted it to #{config.sponsorship.win_post_channel}'
    except Exception as err:
        logger.error('/sponsor won: announcement failed (deal still marked Won)', err)

    computed_note = f' _({parsed.computed})_' if parsed.computed else ''
    kind_note = f' — {parsed.kind.lower()}' if parsed.kind else ''
    _eph(
        respond,
        f'🎉 Marked <{deal.url}|{deal.company}> *Won* at {fmt_usd(parsed.amount_usd)}{computed_note}{kind_note}{announced_suffix}.',
    )


# --- /sponsor stage -----------------------------------------------------------


def parse_stage(arg: str) -> tuple[str, Stage] | None:
    """Parse "Jane Street in talks" → (company, stage). Stage is a trailing keyword."""
    trimmed = arg.strip()
    lower = trimmed.lower()
    for stage in STAGES:
        if lower.endswith(f' {stage.lower()}'):
            company = re.sub(r'[-–—:]$', '', trimmed[: len(trimmed) - len(stage)].strip()).strip()
            if company:
                return company, stage  # type: ignore[return-value]
    return None


def _handle_stage(respond: Respond, user_id: str, arg: str) -> None:
    parsed = parse_stage(arg)
    if not parsed:
        _eph(
            respond,
            f"Usage: `/sponsor stage <company> <stage>`\nStages: {' / '.join(STAGES)}\nExample: `/sponsor stage Jane Street In talks`",
        )
        return
    company, stage = parsed

    deal = resolve_single_deal(respond, company, 'stage')
    if not deal:
        return

    notion.set_stage(deal, stage, today_iso_et())
    tip = ' _(tip: use `/sponsor won <company> <amount>` to record the $ and post the win)_' if stage == 'Won' else ''
    text = f'✅ Moved <{deal.url}|{deal.company}> to *{stage}*.{tip}'
    if stage == 'Lost' and not deal.loss_reason:
        # Same optional one-tap reason as the Lost button (handled in actions.py).
        _eph(
            respond,
            text,
            [
                {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f'{text}\n_Why? One tap, optional:_'}},
                {'type': 'actions', 'elements': loss_reason_buttons(DealButtonValue(deal.id, user_id))},
            ],
        )
        return
    _eph(respond, text)


# --- /sponsor leaderboard -------------------------------------------------------


@dataclass
class LeaderboardRow:
    notion_id: str
    name: str
    won_usd: float = 0
    won_count: int = 0
    active_count: int = 0


def compute_leaderboard(deals: list[PipelineRow], name_by_id: dict[str, str]) -> list[LeaderboardRow]:
    """Aggregate deals per DRI. A co-owned deal credits each DRI in full (a shared win is everyone's
    win) — so rows may sum past the header total, which counts each deal once via total_raised
    (Received-only). Per-person $ is Received-only too, matching the counter. Lost deals count
    toward nothing."""
    rows: dict[str, LeaderboardRow] = {}
    for deal in deals:
        for i in deal.dri_user_ids:
            row = rows.get(i)
            if not row:
                row = rows[i] = LeaderboardRow(notion_id=i, name=name_by_id.get(i) or 'Unknown')
            if deal.stage == 'Won':
                row.won_usd += deal.received or 0
                row.won_count += 1
            elif deal.stage != 'Lost':
                row.active_count += 1
    return sorted(
        rows.values(), key=lambda r: (-r.won_usd, -r.won_count, -r.active_count, r.name.casefold(), r.name)
    )


MEDALS = ('🥇', '🥈', '🥉')
LEADERBOARD_LIMIT = 15


def _handle_leaderboard(respond: Respond) -> None:
    """Ephemeral-only by design (Arjun, 2026-07-08): the leaderboard is background tracking anyone
    can pull up, never a channel post."""
    deals, notion_users, prospects = _parallel(
        notion.query_all_deals, notion.list_notion_users, notion.query_rankable_prospects
    )

    name_by_id = {u.id: u.name for u in notion_users}
    rows = compute_leaderboard(deals, name_by_id)
    available = sum(1 for p in prospects if p.status == 'Available')
    claim_hint = (
        f"\n_{available} researched lead{'' if available == 1 else 's'} waiting in the Bank — `/sponsor claim` one!_"
        if available > 0
        else ''
    )

    if not rows:
        _eph(respond, f"No deals on the board yet.{claim_hint or ' Add prospects with `/sponsor add`.'}")
        return

    total = total_raised([d for d in deals if d.stage == 'Won'])
    goal = config.sponsorship.semester_goal_usd
    pct = math.floor(total / goal * 100 + 0.5) if goal > 0 else 0
    header = f'🏆 *Sponsorship leaderboard* — *{fmt_usd(total)} / {fmt_usd(goal)}* raised ({pct}%)'

    lines = []
    for i, r in enumerate(rows[:LEADERBOARD_LIMIT]):
        badge = MEDALS[i] if r.won_usd > 0 and i < len(MEDALS) else '•'
        won = (
            f"*{fmt_usd(r.won_usd)}* won ({r.won_count} win{'' if r.won_count == 1 else 's'})" if r.won_usd > 0 else 'no wins yet'
        )
        lines.append(f"{badge} *{r.name}* — {won} · {r.active_count} active deal{'' if r.active_count == 1 else 's'}")
    if len(rows) > LEADERBOARD_LIMIT:
        lines.append(f'_…and {len(rows) - LEADERBOARD_LIMIT} more_')
    lines.append('_Co-owned wins credit each DRI in full; the raised total counts each deal once (money in Received)._')

    _eph(respond, '\n'.join([header, *lines]) + claim_hint)


# --- /sponsor claim -----------------------------------------------------------


def _parse_claim(arg: str) -> tuple[str, list[str], list[str]]:
    """→ (company, assignee slack ids, plain handles)."""
    assignee_slack_ids, without_mentions = _take_mentions(unwrap_slack_links(arg))
    plain_handles, cleaned = extract_plain_handles(without_mentions)
    return _leading_company(cleaned), assignee_slack_ids, plain_handles


def _handle_claim(client: WebClient, respond: Respond, caller_slack_id: str, arg: str) -> None:
    """Claim an existing Bank lead → graduate it to a Pipeline deal. No mention needed: it defaults
    to the caller (using their own Slack identity), so it's the clean "own it myself" button. An
    explicit @mention assigns someone else instead."""
    company, assignee_slack_ids, plain_handles = _parse_claim(arg)
    if not company:
        _eph(
            respond,
            'Usage: `/sponsor claim <company> [@person]`\nExample: `/sponsor claim Jane Street` (claims it for you) '
            'or `/sponsor claim Jane Street @teammate`',
        )
        return

    bank = resolve_single_bank_row(respond, company, 'claim')
    if not bank:
        return

    if bank.has_pipeline_deal or bank.status == 'Graduated':
        deals = notion.find_deals_for_bank_row(bank.id)
        link = f' <{deals[0].url}|Open deal>' if deals else ''
        _eph(respond, f'↩︎ *{bank.company}* is already an active deal.{link}')
        return

    # Default owner = the caller; an explicit @mention or @handle assigns someone else.
    has_explicit = bool(assignee_slack_ids or plain_handles)
    assignees = (
        resolve_assignees(client, assignee_slack_ids, plain_handles)
        if has_explicit
        else resolve_assignees(client, [caller_slack_id])
    )
    if not assignees.notion_ids:
        who = ', '.join([*assignees.labels, *assignees.unresolved]) or 'you'
        _eph(respond, f"✗ Couldn't match {who} to a Notion user (by email or name). Ask an admin to check Notion access.")
        return

    deal = notion.create_pipeline_deal(
        PipelineDealInput(
            bank_page_id=bank.id,
            company=bank.company,
            dri_notion_ids=assignees.notion_ids,
            type=bank.type,
            categories=bank.categories,
            contact=bank.contact,
            next_action=FIRST_OUTREACH_ACTION,
            next_action_date_iso=iso_days_from_now_et(7),
        )
    )
    notion.mark_bank_claimed(bank.id, assignees.notion_ids, 'Graduated')

    unresolved_note = f" (couldn't match {', '.join(assignees.unresolved)})" if assignees.unresolved else ''
    _eph(
        respond,
        f"✅ Claimed *{bank.company}* → <{deal.url}|Pipeline deal> (Prospect), owned by {', '.join(assignees.labels)}.{unresolved_note}",
    )


# --- Registration -------------------------------------------------------------


def register_sponsor_commands(app: App) -> None:
    @app.command('/sponsor')
    def _sponsor(ack, command, respond, client):
        parts = (command.get('text') or '').strip().split()
        subcommand = (parts[0] if parts else '').lower()
        arg = ' '.join(parts[1:])
        user_id = command['user_id']

        try:
            if subcommand == 'add':
                # Enrichment is slow (fetch + LLM + Hunter); ack fast, then post via response_url.
                ack(response_type='ephemeral', text=f":hourglass_flowing_sand: Researching *{arg or '…'}*")
                _handle_add(client, respond, arg)
            elif subcommand == 'claim':
                ack()
                _handle_claim(client, respond, user_id, arg)
            elif subcommand == 'ask':
                ack()
                _handle_ask(respond, arg)
            elif subcommand in ('email', 'draft'):
                # Drafting is slow (template + homepage fetch + LLM + Notion writes) — ack fast, then
                # deliver via response_url (same pattern as add).
                ack(response_type='ephemeral', text=f":hourglass_flowing_sand: Drafting outreach for *{arg or '…'}*")
                _handle_email(client, respond, user_id, arg)
            elif subcommand == 'log':
                ack()
                _handle_log(respond, arg)
            elif subcommand == 'won':
                ack()
                _handle_won(client, respond, arg)
            elif subcommand == 'stage':
                ack()
                _handle_stage(respond, user_id, arg)
            elif subcommand == 'score':
                ack()
                _handle_score(respond, arg)
            elif subcommand == 'rank':
                ack()
                _handle_rank(respond, arg)
            elif subcommand == 'find':
                # One LLM pass over the whole unclaimed Bank — ack fast, respond via response_url.
                ack(response_type='ephemeral', text=f":mag: Searching the Bank for *{arg or '…'}*")
                _handle_find(respond, arg)
            elif subcommand in ('scout', 'discover'):
                # Slowest command (generate + N homepage fetches + verify) — can take a minute.
                ack(
                    response_type='ephemeral',
                    text=f":compass: Scouting new companies for *{arg or '…'}* — this can take a minute.",
                )
                _handle_scout(respond, arg)
            elif subcommand in ('leaderboard', 'board', 'top'):
                ack()
                _handle_leaderboard(respond)
            elif subcommand == 'quota':
                # Three Notion queries — ack fast, respond via response_url.
                ack(response_type='ephemeral', text=':clipboard: Checking this week’s quota…')
                _handle_quota(client, respond, user_id)
            elif subcommand == 'me':
                ack()
                _handle_me(client, respond, user_id)
            elif subcommand == 'heatmap':
                ack(response_type='ephemeral', text=heatmap_text())
            else:
                ack(response_type='ephemeral', text=USAGE)
        except Exception as err:
            logger.error(f'/sponsor {subcommand} failed', err)
            _eph(respond, '✗ Something went wrong. Check the PERBot logs.')
