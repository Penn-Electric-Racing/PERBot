"""`/benbuys prep [vendor]` and `/benbuys done <req#> <total> [--no-send]`.
All replies are ephemeral. Vendor defaults to digikey.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from benbuys.adapters.registry import (
    DEFAULT_VENDOR,
    LIVE_VENDORS,
    is_vendor_key,
)
from benbuys.cache import PrepCache
from benbuys.email import build_requisition_email, render_email
from benbuys.mailer import Mailer, create_mailer
from benbuys.models import VendorAdapter
from benbuys.notion import PurchasingNotion
from benbuys.prep import build_prep, format_prep, money
from core import utils
from core.config import config

logger = logging.getLogger(__name__)

__all__ = [
    'ParsedBenbuys', 'REQUISITION_RE', 'parse_money', 'parse_benbuys', 'USAGE',
    'MAX_MESSAGE_CHARS', 'chunk_fenced', 'BenbuysDeps', 'handle_prep', 'handle_done',
]

Respond = Callable[..., Any]


@dataclass
class ParsedBenbuys:
    kind: Literal['help', 'prep', 'done']
    vendor: str = DEFAULT_VENDOR
    requisition: str = ''
    total: float = 0
    dry_run: bool = False
    error: str | None = None


REQUISITION_RE = re.compile(r'^\d{6,8}$')
_DRY_RUN_RE = re.compile(r'^--?(no-send|dry-run)$', re.I)


def parse_money(raw: str) -> float | None:
    """"$1,234.50" · "1234.5" · "402" → number, or None."""
    cleaned = re.sub(r'^\$', '', raw.strip()).replace(',', '')
    if not re.fullmatch(r'\d+(?:\.\d{1,2})?', cleaned):
        return None
    n = float(cleaned)
    if n.is_integer():
        n = int(n)
    return n if n > 0 else None


def parse_benbuys(text: str) -> ParsedBenbuys:
    tokens = text.split()
    sub = (tokens.pop(0) if tokens else '').lower()
    dry_run = any(_DRY_RUN_RE.match(t) for t in tokens)
    args = [t for t in tokens if not _DRY_RUN_RE.match(t)]
    vendor = DEFAULT_VENDOR
    vendor_idx = next((i for i, t in enumerate(args) if is_vendor_key(t)), -1)
    if vendor_idx >= 0:
        vendor = args.pop(vendor_idx).lower()

    if sub == 'prep':
        return ParsedBenbuys('prep', vendor)
    if sub == 'done':
        req = args[0] if args else ''
        total_raw = args[1] if len(args) > 1 else ''
        total = parse_money(total_raw)
        base = ParsedBenbuys('done', vendor, req, total if total is not None else 0, dry_run)
        if not REQUISITION_RE.match(req):
            base.error = f'Requisition number should be 6–8 digits (got "{req or "nothing"}").'
        elif total is None:
            base.error = f'Total should be a positive dollar amount like 402.02 (got "{total_raw or "nothing"}").'
        return base
    return ParsedBenbuys('help')


USAGE = '\n'.join([
    '*BenBuys ordering helper*',
    f"• `/benbuys prep [vendor]` — cart paste block + BEN fields + estimated total from the ready, un-exported Notion rows (vendors: {', '.join(LIVE_VENDORS)}; default {DEFAULT_VENDOR}).",
    '• `/benbuys done <requisition#> <BEN total>` — after Submit on BEN: sends the requisition email and marks the prepped rows ordered in Notion. Add `--no-send` to preview without sending or writing.',
])


def _fence(text: str) -> str:
    return '```\n' + text.replace('```', "'''") + '\n```'


# Slack caps a message at ~40k chars; keep each ephemeral reply comfortably under that.
MAX_MESSAGE_CHARS = 30_000


def chunk_fenced(text: str, max_chars: int = MAX_MESSAGE_CHARS) -> list[str]:
    """Split a code block into several ≤ max_chars fenced chunks on line boundaries."""
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for line in text.split('\n'):
        if size + len(line) + 1 > max_chars and current:
            chunks.append(_fence('\n'.join(current)))
            current = []
            size = 0
        current.append(line)
        size += len(line) + 1
    if current:
        chunks.append(_fence('\n'.join(current)))
    return chunks


@dataclass
class BenbuysDeps:
    notion: Any = field(default_factory=PurchasingNotion)  # PurchasingNotion (or a fake in tests)
    cache: PrepCache = field(default_factory=PrepCache)
    mailer: Mailer | None = field(default_factory=create_mailer)


def _pending_prep_warning(deps: BenbuysDeps, adapter: VendorAdapter, user_id: str) -> str:
    """Prep run by this user in the last 24h that was never closed with `done` — the double-order trap."""
    pending = deps.cache.get(user_id, adapter.key)
    if not pending:
        return ''
    age_min = max(1, utils.js_round((time.time() * 1000 - pending.created_at) / 60_000))
    age = f'{utils.js_round(age_min / 60)}h' if age_min >= 60 else f'{age_min}m'
    return (
        f'⚠️ You prepped {len(pending.prep.lines)} {adapter.label} lines {age} ago and never ran `/benbuys done`. '
        'If you already placed that order, run `done` for it FIRST — otherwise those rows are still un-exported and will be ordered again.\n'
    )


async def handle_prep(deps: BenbuysDeps, adapter: VendorAdapter, user_id: str, respond: Respond) -> None:
    pending_warning = _pending_prep_warning(deps, adapter, user_id)
    selection = await deps.notion.select_rows(adapter)
    prep = build_prep(adapter, selection.ready, selection.not_ready)
    blocks = format_prep(adapter, prep, config.benbuys.approval_threshold)

    if not prep.lines:
        deps.cache.clear(user_id, adapter.key)
        await respond(response_type='ephemeral', text=f'{pending_warning}*{adapter.label} — nothing to order.*\n{blocks.summary}')
        return

    deps.cache.set(user_id, adapter.key, prep)
    header = (
        f"{pending_warning}*{adapter.label} order prep* — paste block 1 into the punchout's Bulk Add box, "
        'block 2 into BEN Financials.'
    )
    cart_chunks = chunk_fenced(blocks.cart)
    tail = f'{_fence(blocks.ben)}\n{blocks.summary}'
    if len(cart_chunks) == 1 and len(header) + len(cart_chunks[0]) + len(tail) < MAX_MESSAGE_CHARS:
        await respond(response_type='ephemeral', text=f'{header}\n{cart_chunks[0]}\n{tail}')
        return
    await respond(response_type='ephemeral', text=f'{header}\n_(cart is long — pasted in {len(cart_chunks)} parts, in order)_')
    for i, chunk in enumerate(cart_chunks):
        await respond(response_type='ephemeral', text=f'Part {i + 1}/{len(cart_chunks)}\n{chunk}')
    await respond(response_type='ephemeral', text=tail)


async def handle_done(deps: BenbuysDeps, adapter: VendorAdapter, user_id: str, parsed: ParsedBenbuys, respond: Respond) -> None:
    if user_id not in adapter.operator_slack_ids:
        await respond(response_type='ephemeral', text=f'Only the {adapter.label} operator can run `/benbuys done`.')
        return
    cached = deps.cache.get(user_id, adapter.key)
    if not cached:
        await respond(
            response_type='ephemeral',
            text=f'No `/benbuys prep {adapter.key}` from you in the last 24h — run prep first so I know exactly which rows you ordered.',
        )
        return
    run_id = f'BENBUYS-{parsed.requisition}'
    if await deps.notion.run_id_exists(run_id):
        await respond(
            response_type='ephemeral',
            text=f'Requisition {parsed.requisition} is already recorded in Notion (Run ID `{run_id}`). Nothing sent.',
        )
        return

    prep = cached.prep
    email = build_requisition_email(
        adapter,
        requisition_number=parsed.requisition,
        total=parsed.total,
        line_count=len(prep.lines),
        from_addr=config.benbuys.from_addr,
        cc=config.benbuys.cc,
        approval_threshold=config.benbuys.approval_threshold,
    )
    flag = 'APPROVAL REQUIRED' if email.approval_required else 'no approval required'

    if parsed.dry_run:
        await respond(
            response_type='ephemeral',
            text='\n'.join([
                f'*Dry run* — nothing sent, nothing written. Requisition {parsed.requisition} · ${money(parsed.total)} · {len(prep.lines)} lines · {flag}.',
                _fence(render_email(email)),
                f'Would mark {len(prep.rows)} rows ordered (Run ID `{run_id}`):',
                '\n'.join(f'• <{r.url}|{r.name or r.part_number}>' for r in prep.rows),
            ]),
        )
        return

    if not deps.mailer:
        await respond(
            response_type='ephemeral',
            text='Email sending isn’t configured on this PERBot deploy (set the BENBUYS_MAIL_* env vars). Nothing sent, nothing written — use `--no-send` to preview.',
        )
        return

    # Email first, so a Notion failure never loses the email.
    try:
        await deps.mailer.send(email)
    except Exception as err:
        logger.error('BenBuys email send failed', exc_info=err)
        await respond(
            response_type='ephemeral',
            text=f'✗ Couldn’t send the requisition email ({err}). Notion was NOT updated — fix the mail config and run `done` again.',
        )
        return

    result = await deps.notion.mark_ordered([r.id for r in prep.rows], run_id)
    if not result.failed:
        deps.cache.clear(user_id, adapter.key)

    lines = [
        f'✅ Requisition {parsed.requisition} · ${money(parsed.total)} · {len(prep.lines)} lines · {flag}.',
        f"Email sent to {', '.join(email.to)} (cc {', '.join(email.cc)}) — subject: {email.subject}",
        f'Notion: {len(result.updated)} rows marked ordered (Run ID `{run_id}`).',
    ]
    if result.failed:
        failed_rows = []
        for fid, ferr in result.failed:
            row = next((r for r in prep.rows if r.id == fid), None)
            failed_rows.append(f"• <{row.url if row else ''}|{(row.name if row else '') or fid}> — {ferr}")
        lines.append(
            f'⚠️ {len(result.failed)} rows failed to update (email already sent — fix by hand or re-run `done`; '
            'the Run ID guard will block until you clear it):\n' + '\n'.join(failed_rows)
        )
    await respond(response_type='ephemeral', text='\n'.join(lines))
