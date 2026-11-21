"""Offline tests for the command-line entry points: regex_scraper.main, llm_reader.find/main,
price_check.check.main and price_check.cli.main. Search, page fetches, the LLM, Notion and Slack
are all faked, and .env loading is disabled so the real keys are never read.

    pip install requests beautifulsoup4 pytest
    pytest
"""
import json
import sys

import pytest

import price_check.cli as test_alert
from core.config import config
from core.notion import Notion
from core.slack import Slack
from price_check import check, checker
from price_check.scrapers import (
    distributors,
    llm_reader,
    llm_scraper,
    regex_reader,
    regex_scraper,
    websearch,
)
from tests.aio import awaitable
from tests.price_check.fakes import CFG, FakeNotion, FakeSlack, page
from tests.price_check.fakes import cfg as fakes_cfg

HITS = [{"title": "LM7805 regulator", "url": "https://a.com/lm7805", "snippet": "LM7805 $0.89",
         "search_rank": 0},
        {"title": "LM7805 at Mouser", "url": "https://www.mouser.com/p/lm7805", "snippet": "",
         "search_rank": 1},
        {"title": "LM7805 10pcs", "url": "https://b.com/lm7805", "snippet": "LM7805 (10pcs) $4.00",
         "search_rank": 2}]


def api_part(cost=0.75):
    """A Mouser result as distributors.lookup returns it (search_rank set)."""
    return {"search_rank": 0, **distributors._candidate("LM7805CT Texas Instruments | Mouser", "https://mouser.com/x",
                                   "Linear regulator", "Mouser Electronics", cost=cost,
                                   currency="USD", price_breaks=[(1, cost)], stock=500,
                                   in_stock=True, shipping_time="ships same day")}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    """No .env, no real network: tests opt in to each fake they need."""
    monkeypatch.setattr(regex_scraper, "load_dotenv", lambda *a: None)
    monkeypatch.setattr(llm_scraper, "load_dotenv", lambda *a: None)
    monkeypatch.setattr(distributors, "lookup", awaitable(lambda *a, **k: ([], [])))
    monkeypatch.setattr(websearch.asyncio, "sleep", awaitable(lambda t: None))


async def run(module, monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", [module.__name__ + ".py", *argv])
    await module.main()


def fake_search(monkeypatch, module, hits=HITS, error=None):
    calls = []

    async def search(query, n, verbose=False, variants=()):
        calls.append((query, n, variants))
        if error:
            raise RuntimeError(error)
        return "fake", [dict(h) for h in hits]
    monkeypatch.setattr(module, "search", search)
    return calls


# ---------------------------------------------------------------- regex_scraper
async def test_regex_scraper_no_fetch_text_output(monkeypatch, capsys):
    calls = fake_search(monkeypatch, regex_scraper)
    await run(regex_scraper, monkeypatch, "LM7805", "-q", "10", "--no-fetch", "-n", "2")
    out = capsys.readouterr().out
    assert calls == [("LM7805 price", 30, ("buy LM7805", "LM7805 in stock"))]
    assert out.startswith('Best 2 of 3 results for "LM7805"  x10  (via fake;')
    assert "1. LM7805 10pcs" in out and "1 pack(s) of 10 = 4.00 USD" in out  # 0.40/unit beats 0.89


async def test_regex_scraper_json_and_exact(monkeypatch, capsys):
    calls = fake_search(monkeypatch, regex_scraper)
    monkeypatch.setattr(regex_reader, "enrich", awaitable(lambda rs: [
        {**r, **regex_reader._blank_info(), "cost": 1.0, "currency": "USD", "cost_source": "json-ld",
         "supplier": r["url"].split("/")[2]} for r in rs]))
    await run(regex_scraper, monkeypatch, "LM7805", "--exact", "--json", "--rank", "cheapest")
    data = json.loads(capsys.readouterr().out)
    assert calls[0] == ("LM7805", 30, ())
    assert data["query"] == "LM7805" and data["rank"] == "cheapest" and data["priced"] == 3
    assert len(data["results"]) == 3 and data["results"][0]["total"] is None


async def test_regex_scraper_adds_api_results_and_drops_their_site(monkeypatch, capsys):
    fake_search(monkeypatch, regex_scraper)
    monkeypatch.setattr(distributors, "lookup", awaitable(lambda *a, **k: ([api_part()], ["mouser"])))
    fetched = []
    monkeypatch.setattr(regex_reader, "enrich", awaitable(lambda rs: fetched.extend(rs) or
                        [{**r, **regex_reader._blank_info(), "supplier": "x"} for r in rs]))
    await run(regex_scraper, monkeypatch, "LM7805", "--json")
    data = json.loads(capsys.readouterr().out)
    assert "www.mouser.com" not in " ".join(r["url"] for r in fetched)  # API replaces the page
    assert data["source"] == "fake + mouser api" and data["results"][0]["cost_source"] == "api"


async def test_regex_scraper_api_only_when_search_fails(monkeypatch, capsys):
    fake_search(monkeypatch, regex_scraper, error="All backends failed: HTTP 202")
    monkeypatch.setattr(distributors, "lookup", awaitable(lambda *a, **k: ([api_part()], ["mouser"])))
    await run(regex_scraper, monkeypatch, "LM7805", "--json")
    data = json.loads(capsys.readouterr().out)
    assert data["source"] == "mouser api" and data["candidates"] == 1


async def test_regex_scraper_exits_with_help_when_everything_fails(monkeypatch):
    fake_search(monkeypatch, regex_scraper, error="All backends failed: HTTP 202")
    with pytest.raises(SystemExit, match="SERPER_API_KEY"):
        await run(regex_scraper, monkeypatch, "LM7805")


@pytest.mark.parametrize("argv", [["x", "-q", "0"], ["x", "-n", "5", "--pool", "2"],
                                  ["x", "--api", "-1"], ["x", "--weights", "/no/such.json"]])
async def test_regex_scraper_rejects_bad_arguments(monkeypatch, argv):
    with pytest.raises(SystemExit):
        await run(regex_scraper, monkeypatch, *argv)


# ---------------------------------------------------------------- llm_reader.find / main
class FakeLLM:
    provider, model = "fake", "fake-model"

    def __init__(self, *a, **k):
        self.prompts = []

    async def json(self, system, user):
        self.prompts.append(user)
        if "Return {\"results\"" in system or "=== [" in user:
            n = user.count("=== [") or user.count("\n[")
            return {"results": [{"index": i, "cost": 1.0 + i, "currency": "USD"}
                                for i in range(max(n, 3))]}
        return {"cost": 2.0, "currency": "USD"}


# Shows every price FakeLLM returns (prices that aren't on the page are dropped).
PRICED_PAGE = "<h1>LM7805</h1> $1.00 $2.00 $3.00"


async def test_find_reads_extra_links_and_dedupes(monkeypatch):
    fake_search(monkeypatch, llm_reader)
    monkeypatch.setattr(llm_reader, "_fetch_html", awaitable(lambda url: PRICED_PAGE))
    llm = FakeLLM()
    _, source, results = await llm_reader.find("LM7805", 5, llm, batch=1, extra=[
        {"title": "mine", "url": "https://mine.com/p"}, {"title": "dup", "url": HITS[0]["url"]}])
    urls = [r["url"] for r in results]
    assert urls.count(HITS[0]["url"]) == 1 and "https://mine.com/p" in urls
    assert source == "fake" and len(llm.prompts) == 4  # 3 hits + 1 extra, one page per request
    assert all(r["score"] is not None for r in results)


async def test_find_ranks_read_pages_without_reading_them_again(monkeypatch):
    fake_search(monkeypatch, llm_reader)
    monkeypatch.setattr(llm_reader, "_fetch_html", awaitable(lambda url: PRICED_PAGE))
    llm = FakeLLM()
    mine = {"title": "LM7805", "url": HITS[0]["url"], "snippet": "", "search_rank": 0,
            **regex_reader._blank_info(), "cost": 3.0, "currency": "USD"}
    _, _, results = await llm_reader.find("LM7805", 1, llm, batch=1, read=[mine])
    assert len(llm.prompts) == 2  # the 2 other hits; the read page isn't fetched again
    assert [r["cost"] for r in results if r["url"] == HITS[0]["url"]] == [3.0]


async def test_find_with_only_extra_links_when_search_fails(monkeypatch):
    fake_search(monkeypatch, llm_reader, error="All backends failed")
    monkeypatch.setattr(llm_reader, "_fetch_html", awaitable(lambda url: "<h1>x</h1>"))
    _, source, results = await llm_reader.find("LM7805", 1, FakeLLM(), extra=[{"title": "m", "url": "https://m.com"}])
    assert source == "none" and [r["url"] for r in results] == ["https://m.com"]
    fake_search(monkeypatch, llm_reader, error="All backends failed")
    with pytest.raises(RuntimeError):
        await llm_reader.find("LM7805", 1, FakeLLM())


async def test_llm_scraper_main_json(monkeypatch, capsys):
    fake_search(monkeypatch, llm_reader)
    monkeypatch.setattr(llm_reader, "LLM", FakeLLM)
    monkeypatch.setattr(llm_reader, "_fetch_html", awaitable(lambda url: PRICED_PAGE))
    await run(llm_scraper, monkeypatch, "LM7805", "--json", "--batch", "3")
    data = json.loads(capsys.readouterr().out)
    assert data["llm"] == "fake/fake-model" and data["priced"] == 3


async def test_llm_scraper_main_no_fetch_text(monkeypatch, capsys):
    fake_search(monkeypatch, llm_reader)
    monkeypatch.setattr(llm_reader, "LLM", FakeLLM)
    await run(llm_scraper, monkeypatch, "LM7805", "--no-fetch", "-n", "1")
    out = capsys.readouterr().out
    assert "via fake + fake/fake-model" in out and "Cost:          1.00 USD  (llm snippet)" in out


async def test_llm_scraper_main_errors(monkeypatch):
    def no_llm(*a, **k):
        raise llm_reader.LLMError("no LLM configured")
    monkeypatch.setattr(llm_reader, "LLM", no_llm)
    with pytest.raises(SystemExit, match="no LLM configured"):
        await run(llm_scraper, monkeypatch, "LM7805")
    monkeypatch.setattr(llm_reader, "LLM", FakeLLM)
    with pytest.raises(SystemExit):
        await run(llm_scraper, monkeypatch, "LM7805", "--batch", "0")
    fake_search(monkeypatch, llm_reader, error="All backends failed")
    with pytest.raises(SystemExit, match="All backends failed"):
        await run(llm_scraper, monkeypatch, "LM7805")


# ---------------------------------------------------------------- price_check.check.main
@pytest.fixture
def bot(monkeypatch):
    """main() with the bot's clients faked: (notion, slack, searched)."""
    notion, slack, searched = FakeNotion(rows=[page("row1")], pages={"row1": page("row1")}), FakeSlack(), []
    monkeypatch.setattr(config, "price_check", CFG)
    monkeypatch.setattr(Notion, "shared", classmethod(lambda cls: notion))
    monkeypatch.setattr(Slack, "shared", classmethod(lambda cls: slack))
    monkeypatch.setattr(checker, "make_llm", lambda *a, **k: FakeLLM())

    def find(base, qty, llm, pool=15, read=(), verbose=False, **k):
        searched.append((base, qty, [e["url"] for e in read]))
        r = {"title": base, "url": "https://www.digikey.com/x", "snippet": "", "search_rank": 0,
             **regex_reader._blank_info(), "cost": 2.0, "currency": "USD", "cost_source": "llm",
             "supplier": "www.digikey.com", "in_stock": True}
        rs = [llm_reader.apply_qty(r, qty)]
        llm_reader.Scorer().score_all(rs, base, qty)
        return base + " price", "fake", rs
    monkeypatch.setattr(llm_reader, "find", awaitable(find))
    monkeypatch.setattr(llm_reader, "part_info", awaitable(lambda r, llm, q: {**r, "mpn": None}))
    return notion, slack, searched


ROW_URL = "https://www.notion.so/X-0123456789abcdef0123456789abcdef"


async def test_price_check_sweep_alerts(bot, caplog):
    notion, slack, searched = bot
    await check.main(["--all", "--limit", "5"])
    assert notion.queries[0][3] == 5  # page size follows --limit
    assert searched == [("LM7805CT/NOPB", 50, ["https://www.digikey.com/x"])]
    assert slack.posts[0][0] == "S1" and "+100%" in slack.posts[0][1]
    assert notion.created == ["price-alert row1 1 x50"]
    assert [p["Outcome"]["select"]["name"] for p in notion.ledger] == ["Pending"]
    assert "Price check: 1 alerted" in caplog.text


async def test_price_check_single_row_dry_run(bot, monkeypatch):
    notion, slack, _ = bot
    notion.page_data["0123456789abcdef0123456789abcdef"] = page("0123456789abcdef0123456789abcdef")
    monkeypatch.setattr(Slack, "shared", classmethod(lambda cls: (_ for _ in ()).throw(AssertionError("Slack used"))))
    await check.main(["--row", ROW_URL, "--dry-run"])
    assert slack.posts == [] and notion.created == [] and notion.ledger == []


async def test_price_check_queue_drains_entries(bot, caplog):
    notion, slack, _ = bot
    notion.entries = [("e1", "price-check-queue row1")]
    await check.main(["--queue"])
    assert notion.done == ["e1"]
    # row1 found by the look-back and queued, then its alert claim, then its savings-ledger row
    assert notion.created == ["price-check-queue row1", "price-alert row1 1 x50"] and len(notion.ledger) == 1
    out = caplog.text
    assert slack.posts and "1 new row(s) queued" in out and "Price check: 1 alerted" in out


async def test_price_check_queue_dry_run_previews_new_rows(bot, caplog):
    notion, _, searched = bot
    await check.main(["--queue", "--dry-run"])
    assert notion.created == [] and notion.done == []
    assert searched and "1 new row(s) would be queued" in caplog.text


async def test_price_check_empty_queue_skips_the_llm(bot, monkeypatch, caplog):
    monkeypatch.setattr(config, "price_check", fakes_cfg(lookback_hours=0))  # no look-back
    monkeypatch.setattr(checker, "make_llm", lambda *a, **k: (_ for _ in ()).throw(AssertionError("LLM used")))
    await check.main(["--queue"])
    assert "queue is empty" in caplog.text and bot[2] == []


async def test_price_check_enqueue(bot, caplog):
    await check.main(["--enqueue", ROW_URL])
    assert bot[0].created == ["price-check-queue 0123456789abcdef0123456789abcdef"]
    assert "queued" in caplog.text


async def test_price_check_bad_arguments(bot):
    with pytest.raises(SystemExit):
        await check.main([])
    with pytest.raises(SystemExit, match="Not a Notion page"):
        await check.main(["--row", "nope"])


async def test_price_check_exits_without_openai(bot, monkeypatch):
    def no_llm(*a, **k):
        raise llm_reader.LLMError("OPENAI_API_KEY not set")
    monkeypatch.setattr(checker, "make_llm", no_llm)
    with pytest.raises(SystemExit, match="OPENAI_API_KEY not set"):
        await check.main(["--all"])


# ---------------------------------------------------------------- price_check.cli (test alert)
async def test_test_alert_dm_uses_the_real_alert_blocks(monkeypatch, capsys):
    notion, slack = FakeNotion(pages={"0123456789abcdef0123456789abcdef": page("p1")}), FakeSlack()
    monkeypatch.setattr(Notion, "shared", classmethod(lambda cls: notion))
    monkeypatch.setattr(Slack, "shared", classmethod(lambda cls: slack))
    await test_alert.main([ROW_URL, "0.80", "--to", "U1", "--supplier", "DigiKey"])
    (channel, text), (blocks,) = slack.posts[0], slack.blocks
    assert channel == "U1" and text == "Test price alert: $1.00 → $0.80"
    assert blocks[0]["text"]["text"].startswith("🧪 *Test price alert on <https://www.notion.so/p1|5V regulator>*")
    actions = blocks[-1]
    assert actions["block_id"] == "price_swap_actions"
    assert all(json.loads(b["value"])["x"] == 1 for b in actions["elements"])  # kept out of the ledger
    assert "Sent to U1" in capsys.readouterr().out
