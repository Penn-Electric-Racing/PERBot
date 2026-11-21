#!/usr/bin/env python3
"""
regex_scraper.py - Find the best 5 places to buy a part.

Searches ~30 results, scrapes each for price / supplier / stock / shipping,
then ranks them and returns the top 5 (weights in ranking.py).

Search backends are in websearch.py (Brave, Serper, Google CSE, DuckDuckGo; the first
that works wins). If the main query gives fewer than --pool unique URLs, "buy <part>" and
"<part> in stock" variants top it up.

Each page is mined for cost, supplier, shipping time/cost, stock, pack size
and quantity price breaks: schema.org JSON-LD first, then meta/microdata
tags, then regex over page text and the search snippet. Sites that block
scripts (eBay, DigiKey, ...) fall back to the snippet.

Ranking (--rank best, default; weights in ranking.py or --weights file.json):
  score = order cost incl. shipping / cheapest order cost  x  penalties for
  out-of-stock or short stock, slow or unknown shipping, estimated shipping
  cost, low-confidence price (snippet / search-results page), listings that
  don't mention the query words or only show a longer variant of the part
  number (LM317L for LM317), and suspiciously cheap outliers.
  1.00 = the cheapest option with no drawbacks. Lower is better.
  Listings without the part number or a price only fill in if too few remain,
  and at most --per-supplier (2) options come from one supplier.
--rank cheapest just sorts by order total (same filters).

Usage:
    pip install requests beautifulsoup4
    python -m price_check.scrapers.regex_scraper "LM7805 voltage regulator"
    python -m price_check.scrapers.regex_scraper "LM7805" -q 50            # need 50 units
    python -m price_check.scrapers.regex_scraper "LM7805" --rank cheapest  # lowest order total only
    python -m price_check.scrapers.regex_scraper "LM7805" --pool 50 -n 10  # compare 50, show best 10
    python -m price_check.scrapers.regex_scraper "query" --json
    python -m price_check.scrapers.regex_scraper "query" --exact           # no "price"/variant queries
    python -m price_check.scrapers.regex_scraper "query" --no-fetch        # snippets only (fast)
"""
import argparse
import json
import sys
from urllib.parse import urlparse

from dotenv import load_dotenv

from core.log import setup_logging
from price_check.scrapers import distributors, regex_reader
from price_check.scrapers.ranking import Scorer, Weights, pick_top
from price_check.scrapers.websearch import (
    _search_help,
    search,
)


def main():
    """Command-line entry point: search, scrape, score and print or dump JSON."""
    p = argparse.ArgumentParser(
        prog="python -m price_check.scrapers.regex_scraper",
        description="Search many part listings, then rank the best N by cost/stock/shipping.")
    p.add_argument("query", nargs="+")
    p.add_argument("-n", "--top", type=int, default=5, help="options to return (default 5)")
    p.add_argument("--pool", type=int, default=30,
                   help="search results to scrape and compare (default 30)")
    p.add_argument("-q", "--qty", type=int, default=1,
                   help="units you need; used for pack math, price breaks and totals (default 1)")
    p.add_argument("--rank", choices=["best", "cheapest"], default="best",
                   help="best = cost weighted by stock/shipping/confidence (default); "
                        "cheapest = lowest order total only")
    p.add_argument("--per-supplier", type=int, default=2,
                   help="max options from one supplier before others get a turn (default 2)")
    p.add_argument("--json", action="store_true", help="output JSON")
    p.add_argument("--exact", action="store_true",
                   help="search the query as-is (default appends 'price' to favor listings)")
    p.add_argument("--no-fetch", action="store_true",
                   help="don't fetch result pages; only parse search snippets")
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
    if a.qty < 1 or a.top < 1 or a.pool < a.top or a.api < 0:
        p.error("need --qty >= 1, --top >= 1, --pool >= --top and --api >= 0")

    try:
        scorer = Scorer(Weights.load(a.weights) if a.weights else None)
    except (OSError, ValueError) as e:
        p.error(f"--weights: {e}")
    base = " ".join(a.query)
    query = base if a.exact or "price" in base.lower() else base + " price"
    variants = () if a.exact else (f"buy {base}", f"{base} in stock")
    api, used = distributors.lookup(base, a.qty, a.api, a.verbose) if a.api else ([], [])
    try:
        source, results = search(query, a.pool, a.verbose, variants)
    except RuntimeError as e:
        msg = str(e)
        if api:  # the distributor APIs alone are still worth ranking
            if a.verbose:
                print(f"web search failed, using APIs only:\n{msg}", file=sys.stderr)
            source, results = "none", []
        else:
            sys.exit(_search_help(msg))
    results = distributors.drop_api_sites(results, used)
    source = " + ".join([source] * bool(results) + [f"{n} api" for n in used])
    if a.verbose:
        print(f"[{source}] {len(results)} web + {len(api)} api candidates, fetching...",
              file=sys.stderr)

    if a.no_fetch:
        for r in results:
            info = regex_reader._blank_info()
            info["listing_page"] = bool(regex_reader.LISTING_URL_RE.search(r["url"]))
            regex_reader._from_text(f"{r['title']} {r['snippet']}", info, "snippet", info["listing_page"])
            info["supplier"] = urlparse(r["url"]).netloc.lower().removeprefix("www.")
            r.update(info)
    else:
        results = regex_reader.enrich(results)
    results = [regex_reader.apply_qty(r, a.qty) for r in results + api]
    scorer.score_all(results, base, a.qty)
    top = pick_top(results, a.top, a.rank, a.per_supplier)
    stats = {"candidates": len(results),
             "fetched": sum(not r.get("fetch_error") for r in results),
             "priced": sum(r["subtotal"] is not None for r in results)}

    if a.json:
        print(json.dumps({"query": query, "qty": a.qty, "source": source, "rank": a.rank,
                          **stats, "results": top}, indent=2))
        return
    print(f'Best {len(top)} of {stats["candidates"]} results for "{base}"  x{a.qty}  '
          f'(via {source}; {stats["fetched"]} pages read, {stats["priced"]} with prices; '
          f'ranked by {a.rank})\n')

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
            what = "listings" if r["listing_page"] else "prices on page"
            print(f"   Price range:   {money(lo, cur)} - {money(hi, cur)}  "
                  f"({r['price_count']} {what})")
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
            print(f"   (page fetch failed: {r['fetch_error']})")
        print()


if __name__ == "__main__":
    setup_logging()
    main()
