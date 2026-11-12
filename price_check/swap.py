"""What a price-check button click does — pure apart from the injected Notion/Slack calls, so it's
tested without either (actions.py wires the real ones).

Use: re-read the row and write the alert's price only if the row still reads what the alert saw
(same Unit cost and Quant., not yet ordered); otherwise say what changed and write nothing. The
listener checks each row once (its Job Log queue entry is permanent), so the write doesn't
trigger another alert. Keep: no write. Undo: the reverse write, under the same guards, for a
day. Every click is also returned as a `ledger` event for the savings ledger (ledger.py).
"""
from __future__ import annotations

import dataclasses
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Literal
from zoneinfo import ZoneInfo

from sponsorship.dates import now_time_et
from price_check.blocks import PriceSwapValue, action_kind, decode_value, escape_mrkdwn, money, replace_actions, result_blocks


class _Unset:
    """`undefined` in a patch: leave the property alone (None means clear it)."""

    def __repr__(self) -> str:
        return 'UNSET'


UNSET: Any = _Unset()


@dataclass
class TextRun:
    """One run of a Notion rich-text value, kept only when every run is plain text (see read_text_runs)."""

    content: str
    link: str | None = None
    annotations: Any = None


@dataclass
class PriceRow:
    id: str
    unit_cost: float | None
    quantity: float | None
    link: str
    exported: bool
    deleted: bool
    # `Notes (internal)` runs; None when it holds mentions/equations we won't rewrite.
    notes: list[TextRun] | None
    # For the savings ledger (a row it has to create itself).
    name: str = ''
    part: str = ''
    season: str = ''
    url: str = ''

    def replace(self, **changes: Any) -> 'PriceRow':
        return dataclasses.replace(self, **changes)


@dataclass
class RowPatch:
    unit_cost: float
    # UNSET = leave the link alone; None = clear it.
    link: Any = UNSET
    # UNSET = leave the notes alone.
    notes: Any = UNSET


@dataclass
class Plan:
    kind: Literal['write', 'already', 'refuse']
    unit_cost: float = 0.0
    link: Any = UNSET
    reason: str = ''


EPS = 1e-6
UNDO_WINDOW_S = 24 * 3600
NOTE_PREFIX = 'PERBot price check:'
NOTION_RICH_TEXT_MAX_RUNS = 100


def _same_money(a: float | None, b: float) -> bool:
    return a is not None and abs(a - b) < EPS


def _norm_url(u: str | None) -> str:
    return re.sub(r'/+$', '', (u or '').strip())


def plan_swap(kind: Literal['use', 'undo'], v: PriceSwapValue, row: PriceRow) -> Plan:
    """Whether clicking `kind` should write, and what. `v['n']` must be set (use/undo values carry it)."""
    if row.deleted:
        return Plan('refuse', reason='This Purchasing row was deleted, so nothing was changed.')
    if row.exported:
        return Plan('refuse', reason='This row is already ordered (*Exported?* is checked), so *Unit cost* was left as is.')
    if row.quantity != v['q']:
        now_q = 'blank' if row.quantity is None else _num(row.quantity)
        return Plan(
            'refuse',
            reason=f'*Quant.* changed since this alert (now {now_q}), so nothing was changed. The row gets re-priced on its own.',
        )
    frm, to = (v['o'], v['n']) if kind == 'use' else (v['n'], v['o'])
    if 'l' not in v:
        to_link: Any = UNSET
    else:
        to_link = v['l'] if kind == 'use' else (v.get('ol') or None)
    link_done = to_link is UNSET or _norm_url(row.link) == _norm_url(to_link)
    if _same_money(row.unit_cost, to) and link_done:
        return Plan('already')
    # Price already at the target but the link isn't (edited by hand halfway): finish the job.
    if not _same_money(row.unit_cost, frm) and not _same_money(row.unit_cost, to):
        now = 'blank' if row.unit_cost is None else f'${money(row.unit_cost)}'
        return Plan('refuse', reason=f'*Unit cost* is now {now} in Notion (changed since this alert), so nothing was changed.')
    return Plan('write', unit_cost=to, link=to_link)


def _num(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else str(n)


def note_line(v: PriceSwapValue, who: str, date_iso: str) -> str:
    """The audit line a Use click leaves in `Notes (internal)`; Undo removes it by its prefix."""
    supplier = f" ({v['s']})" if v.get('s') else ''
    link = ', product link updated' if 'l' in v else ''
    return f'{_note_prefix(v)}{supplier}{link} via Slack, {who}, {date_iso}'


def _note_prefix(v: PriceSwapValue) -> str:
    return f"{NOTE_PREFIX} Unit cost ${money(v['o'])} → ${money(v['n'])}"


def read_text_runs(prop: Any) -> list[TextRun] | None:
    """Plain-text runs of a rich_text property, or None if any run isn't plain text."""
    runs: list[TextRun] = []
    for r in (prop or {}).get('rich_text') or []:
        text = (r or {}).get('text') or {}
        if r.get('type') != 'text' or not isinstance(text.get('content'), str):
            return None
        runs.append(TextRun(text['content'], (text.get('link') or {}).get('url'), r.get('annotations')))
    return runs


def to_rich_text(runs: list[TextRun]) -> list[dict[str, Any]]:
    out = []
    for r in runs:
        item: dict[str, Any] = {'type': 'text', 'text': {'content': r.content, 'link': {'url': r.link} if r.link else None}}
        if r.annotations:
            item['annotations'] = r.annotations
        out.append(item)
    return out


def append_line(runs: list[TextRun], line: str) -> list[TextRun] | None:
    """`runs` plus `line` on its own line, or None when Notion's 100-run cap leaves no room."""
    if len(runs) >= NOTION_RICH_TEXT_MAX_RUNS:
        return None
    has_text = any(r.content for r in runs)
    return [*runs, TextRun(('\n' if has_text else '') + line, None)]


def drop_last_line(runs: list[TextRun], prefix: str) -> list[TextRun] | None:
    """`runs` without a last line that starts with `prefix` (and the newline before it), keeping
    every other run's formatting; None when the last line isn't ours (someone edited after)."""
    full = ''.join(r.content for r in runs)
    nl = full.rfind('\n')
    if not full[nl + 1 :].startswith(prefix):
        return None
    keep = max(nl, 0)
    out: list[TextRun] = []
    for r in runs:
        if keep <= 0:
            break
        content = r.content[:keep]
        keep -= len(content)
        if content:
            out.append(dataclasses.replace(r, content=content))
    return out


@dataclass
class PriceSwapDeps:
    fetch_row: Callable[[str], PriceRow]
    write_row: Callable[[str, RowPatch], None]
    # The clicker's name for the Notion audit line (None → "a Slack user").
    display_name: Callable[[str], str | None]
    now: Callable[[], datetime]


@dataclass
class ClickInput:
    action_id: str
    raw_value: str | None
    clicker: str
    # The message's current blocks (body.message.blocks); absent on some containers.
    existing: list[dict[str, Any]] | None


@dataclass
class LedgerEvent:
    """A click outcome for the savings ledger (ledger.py)."""

    kind: Literal['used', 'kept', 'undone', 'refused']
    value: PriceSwapValue
    clicker: str
    at: datetime


@dataclass
class ClickResult:
    # For the log.
    log: str
    # Rewrite the message to these blocks (replace_original).
    blocks: list[dict[str, Any]] | None = None
    # Plain-text fallback for the rewritten message.
    text: str | None = None
    # Tell only the clicker (ephemeral), leaving the message as is.
    whisper: str | None = None
    # What to record in the savings ledger (actions.py writes it after replying).
    ledger: LedgerEvent | None = field(default=None)


def _et_date(d: datetime) -> str:
    return d.astimezone(ZoneInfo('America/New_York')).strftime('%Y-%m-%d')


def _settle(existing: list[dict[str, Any]] | None, text: str, undo: PriceSwapValue | None = None) -> ClickResult:
    if existing is None:
        return ClickResult(log=text, whisper=text.replace('*', ''))
    return ClickResult(log=text, blocks=replace_actions(existing, result_blocks(text, undo)), text=text.replace('*', ''))


def handle_price_swap(deps: PriceSwapDeps, inp: ClickInput) -> ClickResult:
    kind = action_kind(inp.action_id)
    value = decode_value(inp.raw_value)
    if not kind or not value:
        return ClickResult(log=f'bad value on {inp.action_id}', whisper='This button is out of date. Update *Unit cost* in Notion instead.')
    who = f'<@{inp.clicker}>'
    time = now_time_et(deps.now())

    def event(k: Literal['used', 'kept', 'undone', 'refused'], v: PriceSwapValue = value) -> LedgerEvent:
        return LedgerEvent(k, v, inp.clicker, deps.now())

    if kind == 'keep':
        r = _settle(inp.existing, f"👍 {who} kept ${money(value['o'])}, so Notion wasn't changed · {time}")
        r.ledger = event('kept')
        return r

    if 'n' not in value:
        return ClickResult(log='use/undo without n', whisper='This button has no price on it. Update *Unit cost* in Notion instead.')
    v = value
    if kind == 'undo' and 't' in v and deps.now().timestamp() - v['t'] > UNDO_WINDOW_S:
        return ClickResult(log='undo expired', whisper='Too late to undo from here. Change *Unit cost* in Notion.')

    row = deps.fetch_row(v['r'])
    plan = plan_swap(kind, v, row)
    if plan.kind == 'refuse':
        # A refused Undo leaves the earlier Use standing, so only a refused Use is recorded.
        r = _settle(inp.existing, f'⚠️ {plan.reason}')
        if kind == 'use':
            r.ledger = event('refused')
        return r
    if plan.kind == 'already':
        price = money(v['n'] if kind == 'use' else v['o'])
        r = _settle(inp.existing, f'✅ *Unit cost* is already ${price} in Notion.')
        r.ledger = event('used' if kind == 'use' else 'undone')
        return r

    patch = RowPatch(unit_cost=plan.unit_cost, link=plan.link)
    if row.notes is not None:
        if kind == 'use':
            notes = append_line(row.notes, note_line(v, deps.display_name(inp.clicker) or 'a Slack user', _et_date(deps.now())))
        else:
            notes = drop_last_line(row.notes, _note_prefix(v))
        if notes is not None:
            patch.notes = notes
    deps.write_row(v['r'], patch)

    supplier = f" ({escape_mrkdwn(v['s'])})" if v.get('s') else ''
    if kind == 'use':
        link = ' and updated the product link' if 'l' in v else ''
        undo: PriceSwapValue = {**v, 't': int(deps.now().timestamp())}  # type: ignore[typeddict-item]
        r = _settle(
            inp.existing,
            f"✅ {who} set *Unit cost* to *${money(v['n'])}*{supplier}{link} · was ${money(v['o'])} · {time}",
            undo,
        )
        r.ledger = event('used')
        return r
    link = ' and restored the product link' if 'l' in v else ''
    r = _settle(inp.existing, f"↩️ {who} undid it: *Unit cost* is back to *${money(v['o'])}*{link} · {time}")
    r.ledger = event('undone')
    return r
