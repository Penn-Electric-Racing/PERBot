#!/usr/bin/env python3
"""
llm_scraper.py - regex_scraper.py, but an LLM reads each page instead of regex.

Search (websearch.py) and ranking (ranking.py) are shared with regex_scraper.py.
The difference is extraction: each result page is cut down to
readable text (plus any schema.org JSON-LD), and a free/cheap LLM returns the
fields as JSON:
cost, currency, supplier, shipping time/cost, free-shipping minimum, stock,
pack size and quantity price breaks.

LLM providers (first one with a key wins; all speak the OpenAI chat API):
  1. OpenAI          paid                       env: OPENAI_API_KEY
                     https://platform.openai.com/api-keys
  2. Google Gemini   free tier, no card         env: GEMINI_API_KEY
                     https://aistudio.google.com/apikey
  3. Groq            free tier, no card         env: GROQ_API_KEY
                     https://console.groq.com/keys
  4. OpenRouter      ":free" models             env: OPENROUTER_API_KEY
  5. Ollama          local, free, no key        (if running on localhost:11434)
Override the model with LLM_MODEL=... or --model, the provider with --provider.

Free tiers are rate-limited per minute, so requests are paced (--rpm) and
429s are retried. 30 pages at 15 rpm takes about 2 minutes.

Usage:
    pip install requests beautifulsoup4
    export OPENAI_API_KEY=...
    python -m price_check.scrapers.llm_scraper "LM7805 voltage regulator"
    python -m price_check.scrapers.llm_scraper "LM7805" -q 50 --json
    python -m price_check.scrapers.llm_scraper "LM7805" --no-fetch          # one LLM call over all snippets
    python -m price_check.scrapers.llm_scraper "LM7805" --provider groq --rpm 30
"""
import argparse
import json
import sys

from dotenv import load_dotenv

from core.log import setup_logging
from price_check.scrapers import llm_reader
from price_check.scrapers.ranking import Scorer, Weights, pick_top
from price_check.scrapers.websearch import (
    _search_help,
)


# ---------------------------------------------------------------- main
def main():
    """Command-line entry point: search, LLM-extract, score and print or dump JSON."""
    p = argparse.ArgumentParser(
        prog="python -m price_check.scrapers.llm_scraper",
        description="Like regex_scraper.py, but an LLM extracts price/stock/shipping from each page.")
    p.add_argument("query", nargs="+")
    p.add_argument("-n", "--top", type=int, default=5, help="options to return (default 5)")
    p.add_argument("--pool", type=int, default=30,
                   help="search results to scrape and compare (default 30)")
    p.add_argument("-q", "--qty", type=int, default=1, help="units you need (default 1)")
    p.add_argument("--rank", choices=["best", "cheapest"], default="best",
                   help="best = cost weighted by stock/shipping/confidence "
                        "(default); cheapest = lowest order total only")
    p.add_argument("--per-supplier", type=int, default=2,
                   help="max options from one supplier before others get a turn "
                        "(default 2)")
    p.add_argument("--json", action="store_true", help="output JSON")
    p.add_argument("--exact", action="store_true", help="search the query as-is")
    p.add_argument("--no-fetch", action="store_true",
                   help="don't fetch pages; one LLM call over the search snippets")
    p.add_argument("--provider", choices=list(llm_reader.PROVIDERS), help="LLM provider (default: first with a key)")
    p.add_argument("--model", help="LLM model id (default: provider's free model, or $LLM_MODEL)")
    p.add_argument("--rpm", type=float, default=15,
                   help="max LLM requests per minute (default 15, Gemini's free limit)")
    p.add_argument("--batch", type=int, metavar="N",
                   help="pages per LLM request; fewer requests save daily quota "
                        "(default 5 for openai/gemini, 1 for others)")
    p.add_argument("--weights", metavar="FILE",
                   help="JSON file overriding ranking weights, e.g. {\"out_of_stock\": 2.0} "
                        "(see Weights in ranking.py)")
    p.add_argument("--api", type=int, default=10, metavar="N",
                   help="results per distributor API with keys set (Mouser, DigiKey; "
                        "default 10, 0 = off)")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="log skipped backends, retries and fetch errors to stderr")
    a = p.parse_args()
    load_dotenv()
    if a.qty < 1 or a.top < 1 or a.pool < a.top or a.rpm <= 0 or a.api < 0 or \
            (a.batch is not None and a.batch < 1):
        p.error("need --qty >= 1, --top >= 1, --pool >= --top, --rpm > 0, --api >= 0 "
                "and --batch >= 1")

    try:
        llm = llm_reader.LLM(a.provider, a.model, a.rpm, a.verbose)
    except llm_reader.LLMError as e:
        sys.exit(str(e))
    try:
        scorer = Scorer(Weights.load(a.weights) if a.weights else None)
    except (OSError, ValueError) as e:
        p.error(f"--weights: {e}")
    base = " ".join(a.query)
    try:
        query, source, results = llm_reader.find(base, a.qty, llm, scorer, pool=a.pool, api_n=a.api,
                                      batch=a.batch, exact=a.exact, no_fetch=a.no_fetch,
                                      verbose=a.verbose)
    except RuntimeError as e:
        sys.exit(_search_help(str(e)))
    top = pick_top(results, a.top, a.rank, a.per_supplier)
    stats = {"candidates": len(results),
             "fetched": sum(not r.get("fetch_error") for r in results),
             "priced": sum(r["subtotal"] is not None for r in results)}

    if a.json:
        print(json.dumps({"query": query, "qty": a.qty, "source": source, "rank": a.rank,
                          "llm": f"{llm.provider}/{llm.model}", **stats, "results": top},
                         indent=2))
        return
    print(f'Best {len(top)} of {stats["candidates"]} results for "{base}"  x{a.qty}  '
          f'(via {source} + {llm.provider}/{llm.model}; {stats["fetched"]} pages read, '
          f'{stats["priced"]} with prices; ranked by {a.rank})\n')

    def money(v, cur):
        """Format an amount with its currency, or "n/a"."""
        return "n/a" if v is None else f"{v:,.2f} {cur or ''}".strip()

    for i, r in enumerate(top, 1):
        cur = r["currency"]
        cost = money(r["cost"], cur) + (f"  ({r['cost_source']})" if r["cost"] is not None else "")
        if r["pack_size"] > 1:
            cost += f"  per pack of {r['pack_size']}"
        stock = "n/a" if r["stock"] is None and r["in_stock"] is None else \
            (f"{r['stock']:,}" if r["stock"] is not None else
             "in stock" if r["in_stock"] else "out of stock")
        if r["enough_stock"] is False:
            stock += f"  (NOT enough for {a.qty})"
        score = "unranked (no price)" if r["score"] is None else \
            f"{r['score']:.2f}  (1.00 = cheapest, no drawbacks; search rank #{r['search_rank'] + 1})"
        print(f"{i}. {r['title']}\n   {r['url']}")
        print(f"   Score:         {score}")
        print(f"   Supplier:      {r['supplier']}")
        print(f"   Cost:          {cost}")
        if r["price_range"]:
            lo, hi = r["price_range"]
            print(f"   Price range:   {money(lo, cur)} - {money(hi, cur)}")
        if r["price_breaks"]:
            print("   Price breaks:  " + ", ".join(
                f"{b['min_qty']}+ @ {b['price']:g}" for b in r["price_breaks"]))
        print(f"   Unit cost:     {money(r['unit_cost'], cur)}")
        buy = f"{r['packs_needed']} pack(s) of {r['pack_size']}" if r["pack_size"] > 1 \
            else f"{r['packs_needed']} unit(s)"
        print(f"   Buy:           {buy} = {money(r['subtotal'], cur)}")
        print(f"   Stock:         {stock}")
        print(f"   Shipping time: {r['shipping_time'] or 'n/a'}")
        free_min = (f"  (free over {money(r['free_ship_min'], cur)})"
                    if r["free_ship_min"] is not None else "")
        print(f"   Shipping cost: {r['shipping_cost'] or 'n/a'}{free_min}")
        print(f"   Total:         {money(r['total'], cur)}"
              + ("" if r["total"] is not None or r["subtotal"] is None else
                 f"  (est. {money(r.get('effective_cost'), cur)} incl. typical shipping)"))
        if r["notes"]:
            print(f"   Notes:         {'; '.join(r['notes'])}")
        if r["fetch_error"] and a.verbose:
            print(f"   (fetch/LLM failed: {r['fetch_error']})")
        print()


if __name__ == "__main__":
    setup_logging()
    main()
