"""Read a listing page with JSON-LD, meta tags and regex: price, currency, stock, pack size, shipping
and quantity breaks (`part_info`, `enrich`). The CLI around it is regex_scraper.py.
"""
import json
import re
from urllib.parse import urlparse

from bs4 import BeautifulSoup

from core import aio, http
from price_check.scrapers import distributors
from price_check.scrapers.ranking import Scorer, _alnum
from price_check.scrapers.websearch import (
    BackendError,
    _fetch_html,
)

__all__ = [
    'CURRENCY_SYMBOLS', 'MONEY', 'MONEY_RE', 'NOISE_BEFORE_RE', 'NOISE_AFTER_RE',
    'LISTING_URL_RE', 'FREE_SHIP_RE', 'FREE_SHIP_MIN_RES', 'FREE_SHIP_COND_BEFORE_RE',
    'FREE_SHIP_COND_AFTER_RE', 'SHIP_COST_RE', 'SPAN', 'SHIP_TIME_RES', 'PACK_RES', 'STOCK_RES',
    'OUT_OF_STOCK_RE', 'RELATED_LD_KEYS', 'same_url', 'apply_qty', 'part_info', 'enrich',
    'SCORER', 'score_all',
]

# ---------------------------------------------------------------- part info
CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY"}

# The lookahead rejects split-up display prices like "$ 5 . 99" (would read as $5).
MONEY = (r"(?:US\s?)?([$€£¥])\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,4})?|\d+(?:\.\d{1,4})?)"
         r"(?![\d,]|\s?\.\s?\d)")

MONEY_RE = re.compile(MONEY)

# Amounts that aren't the item's selling price: filters, free-shipping thresholds,
# struck-out list/was prices, discounts, shipping fees.
NOISE_BEFORE_RE = re.compile(
    r"\b(?:under|over|above|below|up to|on|orders?(?:\s(?:over|of|above))?|spend|save|"
    r"savings|off|coupon|was|list(?:\sprice)?|typical(?:\sprice)?|msrp|rrp|reg(?:ular)?|"
    r"compare\sat|retail|shipping|delivery|postage|credit|reward|gift\scard)\W{0,3}$", re.I)

NOISE_AFTER_RE = re.compile(r"^\s?(?:off|or\smore|\+|and\sup|minimum|shipping|delivery)\b",
                            re.I)

# Search / category pages list many different items, so we report the lowest price.
LISTING_URL_RE = re.compile(r"/s\?|/search|/sch/|/b/|[?&](?:q|k|_nkw|keywords?|search)=|"
                            r"/category|/c/|/browse", re.I)

FREE_SHIP_RE = re.compile(r"\bfree\s+(?:standard\s+|ground\s+|economy\s+|2-day\s+)?"
                          r"(?:shipping|delivery)\b", re.I)

# "Free shipping on orders over $100" is conditional, not free: the threshold is
# looked for just after (or before, "spend $50 for free shipping") the match.
FREE_SHIP_MIN_RES = [
    re.compile(r"\b(?:orders?|purchases?|over|above|spend|minimum|min\.?)\b"
               r"[^$€£¥\d]{0,15}" + MONEY, re.I),
    re.compile(r"\bon\s" + MONEY + r"\s?(?:\+|or\smore|of\s)", re.I),  # "on $35 of items"
]

# Conditional offers that don't make *this* order free, so aren't counted:
# "Join Prime to get FREE delivery", "Eligible for Free Shipping" (a search filter),
# "Free Shipping by Amazon", "FREE Shipping on eligible orders".
FREE_SHIP_COND_BEFORE_RE = re.compile(
    r"(?<!non-)\b(?:prime|members?|membership|eligible|qualifying)\b", re.I)

FREE_SHIP_COND_AFTER_RE = re.compile(
    r"^\W{0,3}(?:on\s(?:eligible|qualifying|select)|eligible|"
    r"by\s(?!(?:mon|tue|wed|thu|fri|sat|sun)|tomorrow|today))", re.I)

SHIP_COST_RE = re.compile(r"(?:shipping|delivery|postage)(?:\s+(?:cost|fee|charge|rate))?"
                          r"[^$€£¥\n.]{0,25}" + MONEY, re.I)

SPAN = r"(\d+\s?(?:-|–|to)\s?\d+|\d+)\s?(business\s|working\s)?(hours?|days?|weeks?)"

SHIP_TIME_RES = [
    re.compile(r"\b(?:ships?|dispatch(?:es|ed)?|deliver(?:y|ed|s)?|arrives?|shipping)"
               r"\s(?:with)?in\s(?:about\s)?" + SPAN, re.I),
    re.compile(r"\blead\s?time\W{0,3}(?:of\s)?" + SPAN, re.I),
    re.compile(r"\b(?:arrives?|get it|delivered|delivery)\s(?:by\s)?"
               r"((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s[a-z]{3,9}\.?\s\d{1,2})", re.I),
    re.compile(r"\b(ships\s(?:today|same\sday|next\sbusiness\sday)|same[-\s]day\sshipping)", re.I),
]

PACK_RES = [
    re.compile(r"\b(?:pack|set|lot|box|bag|case|package)\s(?:of\s)?(\d{1,5})\b", re.I),
    re.compile(r"\(?\b(\d{1,5})\s?[-\s]?(?:pcs|pc|pieces|pack|pk|count|ct|units?)\b\)?", re.I),
]

# The lookbehind skips prices: "$0.89 In stock" is not 89 in stock.
STOCK_RES = [
    re.compile(r"(?<![\d.,$€£¥])\b(\d{1,3}(?:,\d{3})+|\d+)\s(?:in\sstock|available|units?\sin\sstock)\b",
               re.I),
    re.compile(r"\b(?:in\sstock|stock|qty\savailable)\W{0,3}(\d{1,3}(?:,\d{3})+|\d+)\b", re.I),
    re.compile(r"\bonly\s(\d+)\sleft\b", re.I),
]

OUT_OF_STOCK_RE = re.compile(r"\b(?:out\sof\sstock|sold\sout|currently\sunavailable|backorder(?:ed)?)\b", re.I)

def _to_float(s):
    """"1,234.50" / 12 / None -> float, or None if it isn't a number."""
    try:
        return float(str(s).replace(",", ""))
    except (TypeError, ValueError):
        return None

# JSON-LD keys that hold *other* products (carousels, accessories) on a product page.
RELATED_LD_KEYS = {"isRelatedTo", "isSimilarTo", "isAccessoryOrSparePartFor",
                   "isConsumableFor", "itemListElement", "review", "isVariantOf"}

def _iter_ld(node, skip=frozenset(), product=None):
    """Yield (dict, owning product name) for every dict inside a JSON-LD blob
    (handles @graph, lists, nesting); keys in `skip` aren't descended into."""
    if isinstance(node, dict):
        if _types(node) & {"Product", "ProductGroup"}:
            product = node.get("name") or product
        yield node, product
        for k, v in node.items():
            if k not in skip:
                yield from _iter_ld(v, skip, product)
    elif isinstance(node, list):
        for v in node:
            yield from _iter_ld(v, skip, product)

def same_url(a, b):
    """True if two URLs point at the same page (ignores www., trailing / and fragment)."""
    a, b = urlparse(a or ""), urlparse(b or "")
    return bool(a.netloc) and (a.netloc.removeprefix("www."), a.path.rstrip("/"), a.query) == \
        (b.netloc.removeprefix("www."), b.path.rstrip("/"), b.query)

def _types(d):
    """A JSON-LD node's @type as a set (it may be a string or a list)."""
    t = d.get("@type", [])
    return {t} if isinstance(t, str) else set(t or [])

def _fmt_span(lo, hi, unit="days"):
    """(2, 5) -> "2-5 days", (None, 3) -> "3 days", (2, None) -> "2+ days"."""
    if lo is None and hi is None:
        return None
    if lo is None or lo == hi:
        return f"{hi} {unit}"
    return f"{lo}-{hi} {unit}" if hi is not None else f"{lo}+ {unit}"

def _ld_breaks(offer, info):
    """Collect quantity price breaks: Offer.eligibleQuantity or priceSpecification entries."""
    specs = offer.get("priceSpecification") or []
    specs = specs if isinstance(specs, list) else [specs]
    for s in [offer] + [s for s in specs if isinstance(s, dict)]:
        eq = s.get("eligibleQuantity")
        price = _to_float(s.get("price"))
        if isinstance(eq, dict) and price is not None:
            min_q = _to_float(eq.get("minValue") or eq.get("value"))
            if min_q:
                info["price_breaks"].append((int(min_q), price))

def _min_qty(offer):
    """Minimum order quantity of a JSON-LD offer (eligibleQuantity), default 1."""
    eq = offer.get("eligibleQuantity")
    return (_to_float(eq.get("minValue") or eq.get("value")) or 1) if isinstance(eq, dict) else 1

def _from_json_ld(soup, info, page_url="", title="", listing=False):
    """Price + details from schema.org JSON-LD. On a product page, only offers of the
    product in the page title count (not related-item carousels), and quantity-break
    offers (min qty > 1) are kept as price breaks rather than the base price."""
    offers = []  # (price, currency, offer url, product name, min qty)
    skip = frozenset() if listing else RELATED_LD_KEYS
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "", strict=False)
        except ValueError:
            continue
        for d, product in _iter_ld(data, skip):
            types = _types(d)
            if types & {"Offer", "AggregateOffer"}:
                price = _to_float(d.get("lowPrice") or d.get("price"))
                if price and price > 0:
                    offers.append((price, d.get("priceCurrency"), d.get("url"), product,
                                   _min_qty(d)))
                    high = _to_float(d.get("highPrice"))
                    if high and high != price:
                        offers.append((high, d.get("priceCurrency"), None, product, _min_qty(d)))
                _ld_breaks(d, info)
                avail = str(d.get("availability") or "")
                if avail and info["in_stock"] is None:
                    info["in_stock"] = avail.rsplit("/", 1)[-1] in ("InStock", "LimitedAvailability",
                                                                    "InStoreOnly", "OnlineOnly")
                inv = d.get("inventoryLevel")
                if isinstance(inv, dict) and info["stock"] is None:
                    stock = _to_float(inv.get("value"))
                    info["stock"] = int(stock) if stock is not None else None
                seller = d.get("seller")
                if isinstance(seller, dict) and seller.get("name") and not info["supplier"]:
                    info["supplier"] = seller["name"]
                ships = d.get("shippingDetails")
                for s in ships if isinstance(ships, list) else [ships]:
                    if not isinstance(s, dict):
                        continue
                    rate = s.get("shippingRate")
                    if isinstance(rate, dict) and info["shipping_cost"] is None:
                        v = _to_float(rate.get("value"))
                        if v is not None:
                            info["shipping_cost"] = "Free" if v == 0 else \
                                f"{v:.2f} {rate.get('currency', '')}".strip()
                    dt = s.get("deliveryTime")
                    if isinstance(dt, dict) and info["shipping_time"] is None:
                        lo = hi = 0
                        found = False
                        for part in ("handlingTime", "transitTime"):
                            p = dt.get(part)
                            if isinstance(p, dict):
                                found = True
                                lo += int(_to_float(p.get("minValue")) or 0)
                                hi += int(_to_float(p.get("maxValue") or p.get("minValue")) or 0)
                        if found and hi:
                            info["shipping_time"] = _fmt_span(lo, hi)
            if "Organization" in types and not info["supplier"] and d.get("name"):
                info["supplier"] = d["name"]
    if not offers:
        return
    if not listing and title:  # drop other products' offers
        t = _alnum(title)
        mine = [o for o in offers if o[3] and _alnum(o[3]) and
                (_alnum(o[3]) in t or t in _alnum(o[3]))]
        offers = mine or offers
    offers = [o for o in offers if o[4] <= 1] or offers  # qty-1 price, not bulk tiers
    prices = sorted({o[0] for o in offers})
    pick = next((o for o in offers if same_url(o[2], page_url)), None)  # linked variant
    if pick is None:
        pick = min(offers, key=lambda o: o[0])  # by price only: tied tuples may hold None
    info["cost"], info["currency"] = pick[0], pick[1] or info["currency"]
    info["cost_source"] = "json-ld" if len(prices) == 1 or pick[2] else \
        f"json-ld (lowest of {len(prices)})"
    info["ld_prices"] = prices
    if len(prices) > 1:
        info["price_range"] = [prices[0], prices[-1]]
        info["price_count"] = len(prices)

def _from_meta(soup, info):
    """Fill price/currency from <meta> or itemprop=price tags, and the supplier from
    og:site_name, when JSON-LD didn't provide them.
    """
    def meta(*names):
        """Content of the first <meta property|name=...> found among `names`."""
        for n in names:
            m = soup.find("meta", attrs={"property": n}) or soup.find("meta", attrs={"name": n})
            if m and m.get("content"):
                return m["content"].strip()
        return None

    if info["cost"] is None:
        price = _to_float(meta("product:price:amount", "og:price:amount"))
        if price is None:
            vals = [_to_float(el.get("content") or re.sub(r"[^\d.,]", "", el.get_text()))
                    for el in soup.select("[itemprop=price]")]
            vals = [v for v in vals if v and v > 0]
            price = vals[0] if vals else None
            if len(set(vals)) > 1:
                info["ld_prices"] = sorted(set(vals))  # cross-checked against the shown price
        # 0.00 is a "call for price" placeholder, not a price: it would rank first.
        if price is not None and price > 0:
            info["cost"] = price
            cur = meta("product:price:currency", "og:price:currency")
            if not cur:
                el = soup.select_one("[itemprop=priceCurrency]")
                cur = el and (el.get("content") or el.get_text(strip=True))
            info["currency"] = cur or info["currency"]
            info["cost_source"] = "meta"
    if not info["supplier"]:
        info["supplier"] = meta("og:site_name", "application-name")

def _text_prices(text):
    """All plausible selling prices in text, in page order, as (value, symbol)."""
    out = []
    for m in MONEY_RE.finditer(text):
        before, after = text[max(0, m.start() - 30):m.start()], text[m.end():m.end() + 15]
        if NOISE_BEFORE_RE.search(before) or NOISE_AFTER_RE.search(after):
            continue
        v = _to_float(m.group(2))
        if v:
            out.append((v, m.group(1)))
    return out

def _ship_threshold(s):
    """Order minimum in a free-shipping phrase ("on orders over $100"), else None."""
    for rx in FREE_SHIP_MIN_RES:
        m = rx.search(s)
        if m:
            return _to_float(m.group(2))
    return None

def _from_text(text, info, source, listing=False):
    """Regex fallback over plain text: fills price, shipping cost / free-shipping
    minimum, shipping time, stock and in/out of stock, only where `info` is still empty.
    `source` labels where a found price came from; `listing` takes the lowest price.
    """
    if info["cost"] is None:
        prices = _text_prices(text)
        if prices:
            # Product page: first real price is the item's. Listing page: lowest.
            v, sym = min(prices) if listing else prices[0]
            info["cost"] = v
            info["currency"] = CURRENCY_SYMBOLS.get(sym, sym)
            info["cost_source"] = source + (f" (lowest of {len(prices)})" if listing
                                            and len(prices) > 1 else "")
            vals = [p for p, _ in prices]
            if len(set(vals)) > 1:
                info["price_range"] = [min(vals), max(vals)]
                info["price_count"] = len(vals)
    if info["shipping_cost"] is None:
        for m in FREE_SHIP_RE.finditer(text):
            if FREE_SHIP_COND_BEFORE_RE.search(text[max(0, m.start() - 25):m.start()]) or \
                    FREE_SHIP_COND_AFTER_RE.search(text[m.end():m.end() + 25]):
                continue
            t = _ship_threshold(text[m.end():m.end() + 50])
            if t is None:
                t = _ship_threshold(text[max(0, m.start() - 40):m.start()])
            if t is None:
                info["shipping_cost"] = "Free"
                break
            if info["free_ship_min"] is None:
                info["free_ship_min"] = t  # apply_qty checks the order against it
        if info["shipping_cost"] is None:
            for m in SHIP_COST_RE.finditer(text):
                if _ship_threshold(text[m.start():m.end() + 15]) is not None:
                    continue  # "shipping on orders over $100" is a threshold, not a fee
                info["shipping_cost"] = f"{m.group(1)}{m.group(2)}"
                break
    if info["shipping_time"] is None:
        for rx in SHIP_TIME_RES:
            m = rx.search(text)
            if m:
                info["shipping_time"] = " ".join(g.strip() for g in m.groups() if g)
                break
    if info["stock"] is None:
        for rx in STOCK_RES:
            m = rx.search(text)
            if m:
                info["stock"] = int(m.group(1).replace(",", ""))
                break
    if info["in_stock"] is None:
        if OUT_OF_STOCK_RE.search(text):
            info["in_stock"] = False
        elif info["stock"] or re.search(r"\bin\sstock\b", text, re.I):
            info["in_stock"] = True

def _pack_size(title):
    """Units per listing, e.g. '(30pcs)' or 'Pack of 10'. Title-only: page text is too noisy."""
    for rx in PACK_RES:
        m = rx.search(title)
        if m and 1 < int(m.group(1)) <= 10000:
            return int(m.group(1))
    return 1

def apply_qty(r, qty):
    """Work out unit cost, packs to buy, order total and stock check for `qty` units."""
    breaks = sorted(set(r["price_breaks"]))
    r["price_breaks"] = [{"min_qty": q, "price": p} for q, p in breaks]
    # Distributor minimum order / order multiple (API results) can mean buying more.
    units = distributors.order_units(qty, r.get("min_order"), r.get("order_mult"))
    # Price breaks are per-unit prices keyed by min quantity; use the best tier reached.
    tier = [p for q, p in breaks if q <= units]
    pack = 1 if tier else _pack_size(r["title"])
    price = tier[-1] if tier else r["cost"]
    packs = -(-units // pack)
    r.update(qty=qty, pack_size=pack, packs_needed=packs,
             unit_cost=None, subtotal=None, total=None, enough_stock=None)
    if r["stock"] is not None:
        # Distributors count stock in units; pack listings usually count packs.
        r["enough_stock"] = r["stock"] * pack >= qty
    elif r["in_stock"] is False:
        r["enough_stock"] = False
    if price is None:
        return r
    r["unit_cost"] = round(price / pack, 4)
    r["subtotal"] = round(price * packs, 2)
    if r["shipping_cost"] is None and r["free_ship_min"] is not None \
            and r["subtotal"] >= r["free_ship_min"]:
        r["shipping_cost"] = "Free"  # order clears the free-shipping threshold
    ship = r["shipping_cost"]
    ship_val = 0.0 if ship == "Free" else _to_float(re.sub(r"[^\d.]", "", ship or "") or None)
    if ship_val is not None:
        r["total"] = round(r["subtotal"] + ship_val, 2)
    return r

def _blank_info():
    """Empty per-listing info dict with every field part_info / apply_qty expect."""
    return {"cost": None, "currency": None, "cost_source": None, "supplier": None,
            "shipping_time": None, "shipping_cost": None, "free_ship_min": None,
            "stock": None, "in_stock": None,
            "price_breaks": [], "price_range": None, "price_count": 0,
            "listing_page": False, "page_title": None, "fetch_error": None,
            "min_order": None, "order_mult": None}

async def part_info(result):
    """Fetch a result page and pull cost / supplier / shipping details."""
    domain = urlparse(result["url"]).netloc.lower().removeprefix("www.")
    info = _blank_info()
    listing = bool(LISTING_URL_RE.search(result["url"]))
    try:
        soup = BeautifulSoup(await _fetch_html(result["url"]), "html.parser")
        h1 = soup.find("h1")
        title = " ".join(h1.get_text(" ").split()) if h1 else ""
        info["page_title"] = title or None
        _from_json_ld(soup, info, result["url"], title or result["title"], listing)
        _from_meta(soup, info)
        # Drop code and struck-out prices (list/was/strike-through) before reading text.
        for t in soup(["script", "style", "noscript", "s", "del", "strike"]):
            t.decompose()
        for t in soup.select('[class*="strike"], [class*="list-price"], [class*="was-price"], '
                             '[class*="old-price"], [class*="original-price"], [data-a-strike]'):
            t.decompose()
        text = " ".join(soup.get_text(" ").split())[:300_000]
        # The product's own price follows its <h1>; header/banner prices come before it.
        at = text.find(title) if title and not listing else -1
        main = text[at:] if at >= 0 else text
        shown = _text_prices(main[:3000])
        ld = info.pop("ld_prices", None)
        if shown and ld and info["cost"] != shown[0][0] and shown[0][0] in ld:
            info["cost"] = shown[0][0]  # the variant/price the page actually displays
            info["cost_source"] = info["cost_source"].split(" (")[0]
        _from_text(main, info, "page text", listing)
        if main is not text:
            _from_text(text, info, "page text", listing)  # banners: free shipping etc.
    except (BackendError, http.RequestError) as e:
        info["fetch_error"] = str(e)
    except Exception as e:  # one malformed page must not abort the whole thread pool
        info["fetch_error"] = f"parse error: {e!r}"
    _from_text(f"{result['title']} {result['snippet']}", info, "snippet", listing)
    info["listing_page"] = listing
    info["supplier"] = info["supplier"] or domain
    return {**result, **info}

async def enrich(results):
    """Run part_info over all results in parallel (up to 10 pages at once)."""
    return list(await aio.map(part_info, results, limit=min(10, len(results) or 1)))

# ---------------------------------------------------------------- ranking
# Scoring lives in ranking.py (tune Weights there, or pass --weights file.json).
SCORER = Scorer()

score_all = SCORER.score_all
