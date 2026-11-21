import dataclasses
import json
import re
from datetime import datetime, timezone

from core import utils
from price_check.enums import ClickKind
from price_check.models import UNSET, Notes, PriceRow, SwapPlan, SwapValue, TextRun
from price_check.views import (
    ACTIONS_BLOCK_ID,
    RESULT_BLOCK_ID,
    UNDO_ACTION_ID,
    ClickInput,
    SwapDeps,
    SwapHandler,
    replace_actions,
)

ROW_ID = '39e560bc-c039-80aa-bbbb-0123456789ab'


def value(**over):
    return {'v': 1, 'r': ROW_ID, 'q': 10, 'o': 50, 'n': 0.68, 's': 'DigiKey', **over}


def row(**over):
    base = dict(id=ROW_ID, unit_cost=50, quantity=10, link='https://www.digikey.com/p/1', exported=False, deleted=False, notes=[])
    return PriceRow(**{**base, **over})


def plain(runs):
    return ''.join(r.content for r in (runs or []))


def test_action_kind_use_keep_undo_with_optional_index_nothing_else():
    assert ClickKind.from_action_id('price_swap_use:0') == 'use'
    assert ClickKind.from_action_id('price_swap_use:12') == 'use'
    assert ClickKind.from_action_id('price_swap_keep') == 'keep'
    assert ClickKind.from_action_id(UNDO_ACTION_ID) == 'undo'
    assert ClickKind.from_action_id('price_swap_use_0') is None
    assert ClickKind.from_action_id('ops_task_done') is None


def test_decode_value_accepts_the_contract_rejects_malformed_payloads():
    ok = {'v': 1, 'r': ROW_ID, 'q': 10, 'o': 50, 'n': 0.68, 's': 'DigiKey', 'l': 'https://mouser.com/x', 'ol': ''}
    assert SwapValue.from_json(json.dumps(ok)).to_payload() == ok
    bare = {'v': 1, 'r': ROW_ID.replace('-', ''), 'q': 1, 'o': 2}
    assert SwapValue.from_json(json.dumps(bare)).to_payload() == bare
    for bad in [
        'not json',
        None,
        {**ok, 'v': 2},
        {**ok, 'r': 'page-1'},
        {**ok, 'q': -1},
        {**ok, 'o': 'fifty'},
        {**ok, 'n': 0},
        {**ok, 'l': 'javascript:alert(1)'},
        {**ok, 'ol': 'ftp://x'},
    ]:
        raw = json.dumps(bad) if isinstance(bad, dict) else bad
        assert SwapValue.from_json(raw) is None, bad


def test_money_matches_price_check_py():
    assert utils.price(50) == '50.00'
    assert utils.price(1234.5) == '1,234.50'
    assert utils.price(0.68) == '0.68'
    assert utils.price(0.5) == '0.50'
    assert utils.price(0.0425) == '0.0425'
    assert utils.price(0.02) == '0.02'


def test_replace_actions_swaps_the_buttons_in_place_drops_an_earlier_outcome_keeps_the_alert():
    alert = {'type': 'section', 'block_id': 'alert', 'text': {'type': 'mrkdwn', 'text': 'Price dropped'}}
    footer = {'type': 'context', 'block_id': 'footer', 'elements': []}
    buttons = {'type': 'actions', 'block_id': ACTIONS_BLOCK_ID, 'elements': []}
    outcome = {'type': 'section', 'block_id': RESULT_BLOCK_ID, 'text': {'type': 'mrkdwn', 'text': 'old'}}
    fresh = [{'type': 'section', 'block_id': RESULT_BLOCK_ID, 'text': {'type': 'mrkdwn', 'text': 'new'}}]
    assert replace_actions([alert, buttons, footer], fresh) == [alert, *fresh, footer]
    assert replace_actions([alert, outcome, buttons, footer], fresh) == [alert, *fresh, footer]
    assert replace_actions([alert], fresh) == [alert, *fresh]


def test_plan_swap_use_writes_only_while_the_row_still_reads_what_the_alert_saw():
    assert row().plan_swap('use', SwapValue.from_payload(value())) == SwapPlan('write', unit_cost=0.68)
    assert row(unit_cost=0.68).plan_swap('use', SwapValue.from_payload(value())) == SwapPlan('already')
    assert re.search(r'now \$42\.00', row(unit_cost=42).plan_swap('use', SwapValue.from_payload(value())).reason)
    assert re.search('now blank', row(unit_cost=None).plan_swap('use', SwapValue.from_payload(value())).reason)
    assert re.search(r'Quant\.\* changed .*now 12', row(quantity=12).plan_swap('use', SwapValue.from_payload(value())).reason)
    assert re.search('already ordered', row(exported=True).plan_swap('use', SwapValue.from_payload(value())).reason)
    assert re.search('deleted', row(deleted=True).plan_swap('use', SwapValue.from_payload(value())).reason)


def test_plan_swap_switching_listings_writes_the_link_too_undo_puts_the_old_one_back_or_clears_it():
    v = value(s='Mouser', n=0.55, l='https://www.mouser.com/p/2', ol='https://www.digikey.com/p/1')
    assert row().plan_swap('use', SwapValue.from_payload(v)) == SwapPlan('write', unit_cost=0.55, link='https://www.mouser.com/p/2')
    # Price written but link not yet → still a write (finishes the job).
    assert row(unit_cost=0.55).plan_swap('use', SwapValue.from_payload(v)) == SwapPlan('write', unit_cost=0.55, link='https://www.mouser.com/p/2')
    assert row(unit_cost=0.55, link='https://www.mouser.com/p/2/').plan_swap('use', SwapValue.from_payload(v)) == SwapPlan('already')
    assert row(unit_cost=0.55, link='https://www.mouser.com/p/2').plan_swap('undo', SwapValue.from_payload(v)) == SwapPlan('write', unit_cost=50, link='https://www.digikey.com/p/1')
    assert row(unit_cost=0.55, link='https://www.mouser.com/p/2').plan_swap('undo', SwapValue.from_payload({**v, 'ol': ''})) == SwapPlan('write', unit_cost=50, link=None)


def test_plan_swap_undo_only_from_the_written_price():
    assert row(unit_cost=0.68).plan_swap('undo', SwapValue.from_payload(value())) == SwapPlan('write', unit_cost=50)
    assert row(unit_cost=50).plan_swap('undo', SwapValue.from_payload(value())) == SwapPlan('already')
    assert row(unit_cost=0.7).plan_swap('undo', SwapValue.from_payload(value())).kind == 'refuse'


def test_notes_append_adds_a_line_drop_last_line_removes_exactly_it_and_keeps_formatting():
    bold = {'bold': True, 'italic': False, 'strikethrough': False, 'underline': False, 'code': False, 'color': 'default'}
    runs = [TextRun('Sold in packs of ', None), TextRun('10', None, bold)]
    added = Notes(runs).append_line('PERBot price check: Unit cost $50.00 → $0.68 via Slack')
    assert plain(added) == 'Sold in packs of 10\nPERBot price check: Unit cost $50.00 → $0.68 via Slack'
    assert Notes(added).drop_last_line('PERBot price check: Unit cost $50.00 → $0.68') == runs
    assert plain(Notes([]).append_line('only line')) == 'only line'
    assert Notes([TextRun('PERBot price check: x', None)]).drop_last_line('PERBot price check:') == []
    assert Notes([TextRun('edited after\nby hand', None)]).drop_last_line('PERBot price check:') is None
    assert Notes([TextRun('x', None) for _ in range(100)]).append_line('y') is None


def test_read_text_runs_plain_text_only():
    assert Notes.read({'rich_text': [{'type': 'text', 'text': {'content': 'a', 'link': {'url': 'https://x.y'}}}]}) == [
        TextRun('a', 'https://x.y')
    ]
    assert Notes.read({'rich_text': []}) == []
    assert Notes.read(None) == []
    assert Notes.read({'rich_text': [{'type': 'mention', 'mention': {}}]}) is None


# ---------------------------------------------------------------- handler, Notion faked


class FakeNotion:
    def __init__(self, start: PriceRow):
        self.row = dataclasses.replace(start)
        self.writes = []
        self.deps = SwapDeps(
            fetch_row=lambda _id: dataclasses.replace(self.row),
            write_row=self._write,
            display_name=lambda _u: 'Arjun Sharma',
            now=lambda: datetime(2026, 10, 17, 16, 31, tzinfo=timezone.utc),
        )

    def _write(self, _id, patch):
        self.writes.append(patch)
        changes = {'unit_cost': patch.unit_cost}
        if patch.link is not UNSET:
            changes['link'] = patch.link or ''
        if patch.notes is not UNSET:
            changes['notes'] = patch.notes
        self.row = dataclasses.replace(self.row, **changes)


def message():
    return [
        {'type': 'section', 'block_id': 'alert', 'text': {'type': 'mrkdwn', 'text': 'Price dropped on TEST'}},
        {'type': 'actions', 'block_id': ACTIONS_BLOCK_ID, 'elements': []},
    ]


def click(action_id, v, existing='default'):
    return ClickInput(action_id, json.dumps(v), 'U123', message() if existing == 'default' else existing)


def test_use_writes_leaves_an_audit_line_and_offers_undo_undo_restores_both():
    notion = FakeNotion(row(notes=[TextRun('Sold in packs of 10', None)]))
    used = SwapHandler(notion.deps).handle(click('price_swap_use:0', value()))
    assert notion.row.unit_cost == 0.68
    assert plain(notion.row.notes) == (
        'Sold in packs of 10\nPERBot price check: Unit cost $50.00 → $0.68 (DigiKey) via Slack, Arjun Sharma, 2026-10-17'
    )
    assert re.search(r'<@U123> set Unit cost to \$0\.68 \(DigiKey\) · was \$50\.00 · 12:31 PM', used.text or '')
    undo_button = next(b for b in used.blocks if b.get('block_id') == ACTIONS_BLOCK_ID)['elements'][0]
    assert undo_button['action_id'] == UNDO_ACTION_ID
    assert used.blocks[0]['block_id'] == 'alert'

    undone = SwapHandler(notion.deps).handle(ClickInput(UNDO_ACTION_ID, undo_button['value'], 'U123', used.blocks))
    assert notion.row.unit_cost == 50
    assert plain(notion.row.notes) == 'Sold in packs of 10'
    assert re.search(r'undid it: Unit cost is back to \$50\.00', undone.text or '')
    assert not any(b.get('block_id') == ACTIONS_BLOCK_ID for b in undone.blocks), 'no buttons after Undo'


def test_a_second_use_click_reports_never_writes_again():
    notion = FakeNotion(row())
    SwapHandler(notion.deps).handle(click('price_swap_use:0', value()))
    again = SwapHandler(notion.deps).handle(click('price_swap_use:0', value()))
    assert len(notion.writes) == 1
    assert re.search(r'already \$0\.68', again.text or '')


def test_a_row_edited_since_the_alert_is_refused_and_left_alone():
    notion = FakeNotion(row(unit_cost=45))
    res = SwapHandler(notion.deps).handle(click('price_swap_use:0', value()))
    assert not notion.writes
    assert re.search(r'⚠️ Unit cost is now \$45\.00', res.text or '')


def test_keep_writes_nothing_notes_with_mentions_are_left_untouched():
    kept = FakeNotion(row())
    v = value()
    del v['n'], v['s']
    res = SwapHandler(kept.deps).handle(click('price_swap_keep', v))
    assert not kept.writes
    assert re.search(r'kept \$50\.00', res.text or '')

    mentions = FakeNotion(row(notes=None))
    SwapHandler(mentions.deps).handle(click('price_swap_use:0', value()))
    assert mentions.writes[0].notes is UNSET
    assert mentions.row.unit_cost == 0.68


def test_bad_value_expired_undo_no_message_blocks_ephemeral_reply():
    notion = FakeNotion(row())
    assert re.search('out of date', SwapHandler(notion.deps).handle(ClickInput('price_swap_use:0', '{oops', 'U123', message())).whisper or '')
    old = int(datetime(2026, 10, 15, tzinfo=timezone.utc).timestamp())
    assert re.search('Too late', SwapHandler(notion.deps).handle(click(UNDO_ACTION_ID, value(t=old))).whisper or '')
    no_blocks = SwapHandler(notion.deps).handle(click('price_swap_use:0', value(), existing=None))
    assert no_blocks.blocks is None
    assert re.search(r'set Unit cost to \$0\.68', no_blocks.whisper or '')
    assert len(notion.writes) == 1
