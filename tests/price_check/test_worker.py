"""Offline tests for price_check/worker.py: polling Notion for new rows, the hourly limit, backoff,
and the worker loop end to end with a real Checker. Notion, Slack and the search are faked."""
from datetime import datetime, timezone

from core import utils
from price_check import worker as pw
from price_check.checker import Checker
from price_check.scrapers import regex_reader
from price_check.scrapers.ranking import Scorer
from tests.aio import awaitable
from tests.price_check.fakes import CFG, FakeNotion, FakeSlack, page

NOW = datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc).timestamp()


class FakeClock:
    def __init__(self, t=NOW):
        self.t = t

    def __call__(self):
        return self.t


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace('+00:00', 'Z')


class FakeChecker:
    def __init__(self, notion, status='ok'):
        self.notion, self.status, self.drained = notion, status, []

    async def drain(self, entries):
        self.drained += entries
        if self.status != 'retry':  # a real drain marks the entry done: it leaves the queue
            self.notion.entries = [e for e in self.notion.entries if e[0] not in {x for x, _ in entries}]
        return {self.status: 1}


def worker(entries=(), rows=(), status='ok', per_hour=20, dry_run=False, poll=False):
    clock = FakeClock()
    notion = FakeNotion(rows=rows, entries=[(e, f'price-check-queue {p}') for e, p in entries])
    poller = pw.Poller(notion, CFG, clock=clock, dry_run=dry_run) if poll else None
    w = pw.Worker(CFG, notion, FakeChecker(notion, status), pw.HourlyLimit(per_hour, clock=clock), poller,
                  clock=clock, dry_run=dry_run)
    return w, notion, clock


# ---------------------------------------------------------------- poller
async def test_first_poll_looks_back_the_lookback_then_one_interval():
    notion = FakeNotion(rows=[page('old', edited=iso(NOW - 3 * 86400))])
    clock = FakeClock()
    p = pw.Poller(notion, CFG, clock=clock)
    assert await p.poll() == ['old']

    def since(i):
        return next(c['last_edited_time']['on_or_after'] for c in notion.queries[i][1]['and']
                    if c.get('timestamp') == 'last_edited_time')

    def at(ts):
        return utils.to_iso(datetime.fromtimestamp(ts, timezone.utc))
    assert since(0) == at(NOW - 168 * 3600)
    clock.t += 120
    assert p.due()
    await p.poll()
    assert since(1) == at(clock.t - (120 + 60 + pw.WINDOW_SLACK))


async def test_rows_still_being_edited_wait_for_a_later_poll():
    # Edited 90 s ago: within settle (60 s) + Notion's minute rounding, so not yet.
    notion = FakeNotion(rows=[page('busy', edited=iso(NOW - 90)), page('done', edited=iso(NOW - 600))])
    clock = FakeClock()
    p = pw.Poller(notion, CFG, clock=clock)
    assert await p.poll() == ['done']
    clock.t += 120
    assert await p.poll() == ['busy']  # the next window still reaches back to it
    assert notion.created == ['price-check-queue done', 'price-check-queue busy']


async def test_dry_run_poll_writes_nothing_and_reports_a_row_once():
    notion = FakeNotion(rows=[page('p1', edited=iso(NOW - 600))])
    clock = FakeClock()
    p = pw.Poller(notion, CFG, clock=clock, dry_run=True)
    assert await p.poll() == ['p1']
    clock.t += 120
    assert await p.poll() == [] and notion.created == []


async def test_not_due_until_the_interval_passes():
    clock = FakeClock()
    p = pw.Poller(FakeNotion(), CFG, clock=clock)
    await p.poll()
    clock.t += 119
    assert not p.due()
    clock.t += 1
    assert p.due()


# ---------------------------------------------------------------- worker
async def test_worker_checks_one_queued_row_per_step():
    w, _, _ = worker(entries=[('e1', 'p1'), ('e2', 'p2')])
    assert await w.check_next() == 'ok' and w.checker.drained == [('e1', 'p1')]
    assert await w.check_next() == 'ok' and w.checker.drained[-1] == ('e2', 'p2')


async def test_empty_queue_is_looked_at_every_few_minutes_unless_a_poll_adds_rows():
    w, notion, clock = worker(rows=[page('p1', edited=iso(NOW - 600))], poll=True)
    w.poller.next_at = NOW + 1  # not due yet
    assert await w.step() is None and w.next_queue_look == clock.t + pw.QUEUE_POLL_SECONDS
    clock.t += 1
    assert await w.poll() == 1 and w.next_queue_look == 0.0  # the poll queued p1: look right away
    assert notion.created == ['price-check-queue p1']


async def test_hourly_limit_and_skips():
    w, _, clock = worker(entries=[('e1', 'p1'), ('e2', 'p2')], per_hour=1)
    await w.check_next()
    assert await w.check_next() is None  # limit reached
    clock.t += 3600
    assert await w.check_next() == 'ok'
    w2, _, _ = worker(entries=[('e1', 'p1'), ('e2', 'p2')], per_hour=1, status='skipped')
    await w2.check_next()
    assert w2.limit.wait() == 0  # skipped rows don't use the limit


async def test_failures_back_off_and_stay_queued():
    w, notion, clock = worker(entries=[('e1', 'p1')], status='retry')
    assert await w.check_next() == 'retry' and w.backoff_until == clock.t + 600
    assert await w.check_next() is None  # backing off
    clock.t = w.backoff_until
    await w.check_next()
    assert w.backoff_until == clock.t + 1200 and len(notion.entries) == 1
    w.failures = 50
    clock.t = w.backoff_until
    await w.check_next()
    assert w.backoff_until == clock.t + pw.RETRY_MAX_SECONDS
    w.checker.status = 'ok'
    clock.t = w.backoff_until
    assert await w.check_next() == 'ok' and w.failures == 0


async def test_dry_run_previews_without_writing_or_looping():
    w, notion, _ = worker(entries=[('e1', 'p0')], rows=[page('p1', edited=iso(NOW - 600))], dry_run=True, poll=True)
    assert await w.poll() == 1 and notion.created == [] and w.preview == ['p1']
    assert await w.check_next() == 'ok' and w.checker.drained == [('e1', 'p0')]
    notion.entries = [('e1', 'price-check-queue p0')]  # dry runs never mark entries done...
    assert await w.check_next() == 'ok' and w.checker.drained[-1] == (None, 'p1')  # ...but move on
    w.next_queue_look = 0
    assert await w.check_next() is None


async def test_failed_poll_is_logged_and_retried_next_interval(caplog):
    w, notion, clock = worker(poll=True)

    def down(*a, **k):
        raise RuntimeError('Notion HTTP 502')
    notion.data_sources.query = down
    assert await w.poll() == 0 and 'polling Purchasing failed' in caplog.text
    assert not w.poller.due()
    clock.t += CFG.poll_seconds
    assert w.poller.due()


async def test_run_keeps_going_after_a_step_raises():
    w, _, _ = worker()
    calls = []

    async def step():
        calls.append('step')
        if len(calls) == 1:
            raise RuntimeError('Notion HTTP 502')
        w.stopped.set()
        return None
    w.step = step
    w.sleep = awaitable(calls.append)
    await w.run()
    assert calls == ['step', 60, 'step', 2]


def test_worker_is_not_built_without_openai(monkeypatch, caplog):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    assert pw.Worker.from_config() is None
    assert 'Price check: not started: OPENAI_API_KEY not set' in caplog.text


# ---------------------------------------------------------------- end to end
async def test_new_row_to_slack_dm(monkeypatch):
    """Poll finds a settled row -> queued in the Job Log -> checked -> DM -> entry marked done."""
    clock = FakeClock()
    row = page('p1', edited=iso(NOW - 600))
    notion = FakeNotion(rows=[row], pages={'p1': row})
    slack = FakeSlack()

    def find(r):
        hit = {'title': 'LM7805CT/NOPB', 'url': 'https://shop.com/p1', 'snippet': '', 'search_rank': 0,
               **regex_reader._blank_info(), 'cost': 2.0, 'currency': 'USD', 'cost_source': 'llm',
               'supplier': 'shop.com', 'in_stock': True, 'shipping_cost': 'Free', 'shipping_time': '2 days'}
        rs = [regex_reader.apply_qty(hit, r.units)]
        Scorer().score_all(rs, r.part_number, r.units)
        return rs

    w = pw.Worker(CFG, notion, Checker(CFG, notion, slack, awaitable(find)), pw.HourlyLimit(20, clock=clock),
                  pw.Poller(notion, CFG, clock=clock), clock=clock)
    # Queue entries the fake Job Log hands back come from the claims the poll made.
    real_query = notion.data_sources.query

    async def query(data_source_id, filter=None, **kw):
        if (filter or {}).get('property') == 'Job':
            notion.entries = [(f'e-{k.split()[-1]}', k) for k in notion.created
                              if k.startswith('price-check-queue') and f'e-{k.split()[-1]}' not in notion.done]
        return await real_query(data_source_id, filter=filter, **kw)
    notion.data_sources.query = query

    assert await w.step() == 'alerted'
    assert slack.posts and slack.posts[0][0] == 'S1' and '+100%' in slack.posts[0][1]
    assert notion.created == ['price-check-queue p1', 'price-alert p1 1 x50']
    assert notion.done == ['e-p1'] and len(notion.ledger) == 1
    clock.t += 120
    assert await w.step() is None  # edited again? still queued once, ever: nothing new
