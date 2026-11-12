import re
from types import SimpleNamespace

from benbuys.cache import PrepCache
from benbuys.notion import RowSelection, WriteBackResult
from benbuys.prep import build_prep
from benbuys.slack import BenbuysDeps, ParsedBenbuys, chunk_fenced, handle_done, handle_prep, parse_benbuys, parse_money

from .helpers import row, test_adapter


def test_parse_benbuys_prep_defaults_to_digikey_vendor_may_be_given():
    assert parse_benbuys('prep') == ParsedBenbuys('prep', 'digikey')
    assert parse_benbuys('  PREP  DigiKey ') == ParsedBenbuys('prep', 'digikey')
    assert parse_benbuys('prep mcmaster') == ParsedBenbuys('prep', 'mcmaster')
    assert parse_benbuys('') == ParsedBenbuys('help')
    assert parse_benbuys('help') == ParsedBenbuys('help')


def test_parse_benbuys_done_takes_req_and_total_optional_vendor_and_no_send_anywhere():
    assert parse_benbuys('done 4321745 402.02') == ParsedBenbuys('done', 'digikey', '4321745', 402.02, False)
    assert parse_benbuys('done 4321745 $1,204.50 --no-send') == ParsedBenbuys('done', 'digikey', '4321745', 1204.5, True)
    assert parse_benbuys('done digikey 4321745 402') == ParsedBenbuys('done', 'digikey', '4321745', 402, False)
    assert parse_benbuys('done --dry-run 4321745 402') == ParsedBenbuys('done', 'digikey', '4321745', 402, True)


def test_parse_benbuys_done_guards():
    assert re.search('6–8 digits', parse_benbuys('done 12345 402').error or '')
    assert re.search('6–8 digits', parse_benbuys('done 123456789 402').error or '')
    assert re.search('positive dollar amount', parse_benbuys('done 4321745').error or '')
    assert re.search('positive dollar amount', parse_benbuys('done 4321745 0').error or '')
    assert re.search('positive dollar amount', parse_benbuys('done 4321745 -5').error or '')
    assert re.search('positive dollar amount', parse_benbuys('done 4321745 402.123').error or '')


def test_parse_money():
    assert parse_money('$1,234.5') == 1234.5
    assert parse_money('402') == 402
    assert parse_money('abc') is None


def test_chunk_fenced_splits_long_carts_on_line_boundaries_each_part_fenced():
    lines = [f'{i}, PART-{i}-ND, REF' for i in range(50)]
    chunks = chunk_fenced('\n'.join(lines), 200)
    assert len(chunks) > 1
    for c in chunks:
        assert c.startswith('```\n') and c.endswith('\n```')
        assert len(c) <= 200 + 8
    assert '\n'.join(c[4:-4] for c in chunks) == '\n'.join(lines)


def test_prep_cache_keyed_by_user_and_vendor_expires_after_the_ttl():
    clock = {'now': 1_000}
    cache = PrepCache(24 * 3600 * 1000, lambda: clock['now'])
    prep = build_prep(test_adapter, [row('A-ND')], [])
    cache.set('U1', 'digikey', prep)
    assert cache.get('U1', 'digikey').prep is prep
    assert cache.get('U2', 'digikey') is None
    assert cache.get('U1', 'mcmaster') is None
    clock['now'] += 24 * 3600 * 1000 + 1
    assert cache.get('U1', 'digikey') is None


def fake_deps(run_id_exists=False, fail_ids=(), mailer='ok'):
    sent = []
    written = []

    def mark_ordered(ids, run_id):
        written.append((ids, run_id))
        return WriteBackResult(updated=[i for i in ids if i not in fail_ids], failed=[(i, 'boom') for i in fail_ids])

    def send(email):
        if mailer == 'fail':
            raise RuntimeError('smtp down')
        sent.append(email)
        return 'm1'

    deps = BenbuysDeps(
        notion=SimpleNamespace(run_id_exists=lambda _r: run_id_exists, mark_ordered=mark_ordered),
        cache=PrepCache(),
        mailer=None if mailer is None else SimpleNamespace(name='fake', send=send),
    )
    return deps, sent, written


def replies():
    out: list[str] = []
    return out, lambda **msg: out.append(msg['text'])


DONE = ParsedBenbuys('done', 'digikey', '4321745', 402.02, False)


def test_handle_done_refuses_non_operators_then_missing_prep_then_duplicate_run_id():
    deps, sent, written = fake_deps(run_id_exists=True)
    out, respond = replies()
    handle_done(deps, test_adapter, 'U_STRANGER', DONE, respond)
    assert re.search('Only the DigiKey operator', out[0])

    out, respond = replies()
    handle_done(deps, test_adapter, 'U_OPERATOR', DONE, respond)
    assert re.search('run prep first', out[0])

    deps.cache.set('U_OPERATOR', 'digikey', build_prep(test_adapter, [row('A-ND')], []))
    out, respond = replies()
    handle_done(deps, test_adapter, 'U_OPERATOR', DONE, respond)
    assert re.search(r'already recorded in Notion \(Run ID `BENBUYS-4321745`\)', out[0])
    assert not sent
    assert not written


def test_handle_done_no_send_previews_the_email_and_rows_writes_nothing_keeps_the_cache():
    deps, sent, written = fake_deps(mailer=None)
    deps.cache.set('U_OPERATOR', 'digikey', build_prep(test_adapter, [row('A-ND', quantity=2, unit_cost=300)], []))
    out, respond = replies()
    handle_done(deps, test_adapter, 'U_OPERATOR', ParsedBenbuys('done', 'digikey', '4321745', 600, True), respond)
    assert re.search(r'\*Dry run\*.*\$600\.00 · 1 lines · APPROVAL REQUIRED', out[0])
    assert re.search(r'Subject: \[APPROVAL REQUIRED\] PER Requisition 4321745', out[0])
    assert re.search(r'Would mark 1 rows ordered \(Run ID `BENBUYS-4321745`\)', out[0])
    assert not sent
    assert not written
    assert deps.cache.get('U_OPERATOR', 'digikey')


def test_handle_done_no_mailer_configured_refuses_before_writing():
    deps, _, written = fake_deps(mailer=None)
    deps.cache.set('U_OPERATOR', 'digikey', build_prep(test_adapter, [row('A-ND')], []))
    out, respond = replies()
    handle_done(deps, test_adapter, 'U_OPERATOR', DONE, respond)
    assert 'isn’t configured' in out[0]
    assert not written


def test_handle_done_email_failure_notion_untouched_cache_kept_for_a_retry():
    deps, _, written = fake_deps(mailer='fail')
    deps.cache.set('U_OPERATOR', 'digikey', build_prep(test_adapter, [row('A-ND')], []))
    out, respond = replies()
    handle_done(deps, test_adapter, 'U_OPERATOR', DONE, respond)
    assert re.search(r'Couldn’t send the requisition email \(smtp down\)\. Notion was NOT updated', out[0])
    assert not written
    assert deps.cache.get('U_OPERATOR', 'digikey')


def test_handle_done_happy_path_email_then_write_back_to_exactly_the_cached_rows_then_cache_cleared():
    deps, sent, written = fake_deps()
    rows = [row('A-ND', id='p1'), row('a-nd', id='p2'), row('B-ND', id='p3')]
    deps.cache.set('U_OPERATOR', 'digikey', build_prep(test_adapter, rows, []))
    out, respond = replies()
    handle_done(deps, test_adapter, 'U_OPERATOR', DONE, respond)
    assert len(sent) == 1
    assert sent[0].subject == '[NO APPROVAL REQUIRED] PER Requisition 4321745'
    assert '(2 line items)' in sent[0].body  # 3 rows → 2 aggregated lines, as BEN counts them
    assert written == [(['p1', 'p2', 'p3'], 'BENBUYS-4321745')]
    assert re.search(r'✅ Requisition 4321745 · \$402\.02 · 2 lines · no approval required\.', out[0])
    assert 'Notion: 3 rows marked ordered' in out[0]
    assert deps.cache.get('U_OPERATOR', 'digikey') is None


def test_handle_done_partial_write_back_failure_is_reported_and_the_cache_is_kept():
    deps, _, written = fake_deps(fail_ids=('p2',))
    rows = [row('A-ND', id='p1'), row('B-ND', id='p2', name='Second part')]
    deps.cache.set('U_OPERATOR', 'digikey', build_prep(test_adapter, rows, []))
    out, respond = replies()
    handle_done(deps, test_adapter, 'U_OPERATOR', DONE, respond)
    assert len(written) == 1
    assert 'Notion: 1 rows marked ordered' in out[0]
    assert re.search(r'⚠️ 1 rows failed to update.*\n• <https://notion\.so/page-\d+\|Second part> — boom', out[0])
    assert deps.cache.get('U_OPERATOR', 'digikey')


def test_handle_prep_caches_the_result_and_warns_when_a_previous_prep_was_never_closed_with_done():
    # 6-char descriptions ("PART n") carry too little signal, so the reference falls back to the part number.
    ready = [row('A-ND', quantity=2, unit_cost=1.5, sanitized_description='PART 1'), row('B-ND', sanitized_description='PART 2')]
    deps = BenbuysDeps(notion=SimpleNamespace(select_rows=lambda _a: RowSelection(ready, [])), cache=PrepCache(), mailer=None)
    out, respond = replies()
    handle_prep(deps, test_adapter, 'U_OPERATOR', respond)
    assert len(out) == 1
    assert 'never ran' not in out[0]
    assert '*DigiKey order prep*' in out[0]
    assert '2, A-ND, A-ND\n1, B-ND, B-ND' in out[0]  # 6-char "PART n" notes fall back to the part number
    assert len(deps.cache.get('U_OPERATOR', 'digikey').prep.rows) == 2

    # Second prep without a done in between → double-order warning up top.
    out, respond = replies()
    handle_prep(deps, test_adapter, 'U_OPERATOR', respond)
    assert re.match(r'^⚠️ You prepped 2 DigiKey lines \dm ago and never ran `/benbuys done`', out[0])

    # Nothing to order → no cache entry, so a later prep won't warn.
    deps.notion = SimpleNamespace(select_rows=lambda _a: RowSelection([], []))
    out, respond = replies()
    handle_prep(deps, test_adapter, 'U_OPERATOR', respond)
    assert 'nothing to order' in out[0]
    assert deps.cache.get('U_OPERATOR', 'digikey') is None
