"""Photo(s) of a delivery + the Slack text around it → a fixed-schema `Scan`, via the OpenAI vision
model (Groq's gpt-oss-120b is text-only). Several photos in one message are read in ONE call. The
schema has no price fields: slips print costs, and anything the model never transcribes can never
leak into a Slack reply.

The message text matters as much as the photo: in #packages people write "Jlc picked up", "Hv
wiring is here", "@Elijah cooling tube is here" over a picture of a box or its contents.
"""
from __future__ import annotations

import base64
import json
import math
import re
from dataclasses import dataclass
from typing import Any

from openai import OpenAI

from config import config, has_openai
from arrivals.models import Extraction, OrderNumber, Scan, SlipLine


@dataclass
class SlipImage:
    # JPEG / PNG / WebP / GIF bytes.
    data: bytes
    mime_type: str


@dataclass
class ScanContext:
    # The message the photo was posted with (Slack mentions already replaced by names).
    text: str
    # The thread's first message, when the photo is a reply.
    parent_text: str | None = None


ORDER_KINDS = ['purchase_order', 'sales_order', 'invoice', 'customer_reference', 'other']
SCENES = ['packing_slip', 'shipping_label', 'contents', 'several_packages', 'not_a_delivery']

_NULLABLE_STRING = {'type': ['string', 'null']}

LINE_SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['vendor_part_number', 'manufacturer_part_number', 'description', 'quantity_shipped', 'customer_reference'],
    'properties': {
        'vendor_part_number': _NULLABLE_STRING,
        'manufacturer_part_number': _NULLABLE_STRING,
        'description': _NULLABLE_STRING,
        'quantity_shipped': {'type': ['number', 'null']},
        'customer_reference': _NULLABLE_STRING,
    },
}

PACKAGE_SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['vendor', 'addressee', 'ship_date', 'order_numbers', 'tracking_numbers', 'lines', 'item_hints'],
    'properties': {
        'vendor': _NULLABLE_STRING,
        'addressee': _NULLABLE_STRING,
        'ship_date': _NULLABLE_STRING,
        'order_numbers': {
            'type': 'array',
            'items': {
                'type': 'object',
                'additionalProperties': False,
                'required': ['kind', 'value'],
                'properties': {'kind': {'type': 'string', 'enum': ORDER_KINDS}, 'value': {'type': 'string'}},
            },
        },
        'tracking_numbers': {'type': 'array', 'items': {'type': 'string'}},
        'lines': {'type': 'array', 'items': LINE_SCHEMA},
        'item_hints': {'type': 'array', 'items': {'type': 'string'}},
    },
}

SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['scene', 'legible', 'packages'],
    'properties': {
        'scene': {'type': 'string', 'enum': SCENES},
        'legible': {'type': 'boolean'},
        'packages': {'type': 'array', 'items': PACKAGE_SCHEMA},
    },
}

PROMPT = """You are reading a photo posted in Penn Electric Racing's #packages Slack channel, where teammates post deliveries
(boxes, mailers, shipping labels, packing slips, or the parts inside). Transcribe only what is visible or stated; never
guess or complete a number you cannot read (use null).

scene — the main thing shown:
  packing_slip (a packing list / invoice / bill of lading listing items), shipping_label (the outside of one package),
  contents (unpacked parts, no readable paperwork), several_packages (two or more separate packages),
  not_a_delivery (food, people, trophies on display, screenshots, memes, shelves or bins showing where things are stored —
  e.g. the message says where something was put, "X in the rev11 substack" — anything that isn't a package that just arrived).
legible — false if there are labels or paperwork but they are too blurry, small, cropped, or far away to read.

packages — one entry per separate package you can tell apart (none for not_a_delivery). For each:
  vendor: who shipped it — the label's FROM/shipper line, the brand printed on the box or tape (DigiKey, McMaster-Carr,
    JLCPCB, Amazon, Mouser...), or the Slack message if it names one ("Jlc picked up" → JLCPCB). Never the carrier
    (UPS, FedEx, USPS, DHL) and never "University of Pennsylvania".
  addressee: the PERSON named on the label (ship-to / attn / consignee), e.g. "Katherine Shen"; null if only the university.
  ship_date: ship date printed on the label or slip, written as YYYY-MM-DD ("SHIP DATE: 28SEP26" → 2026-09-28), else null.
  order_numbers: every order-identifying number, labelled purchase_order (PO / Customer PO), sales_order (vendor order /
    sales order / web order), invoice, customer_reference (REF fields), or other.
  tracking_numbers: carrier tracking numbers.
  lines: item lines from a packing slip or contents label. vendor_part_number = the vendor's catalog number (DigiKey's ends
    in -ND); manufacturer_part_number = the maker's number; quantity_shipped = quantity shipped in this box (0 if
    backordered); customer_reference = per-line reference text if printed.
  item_hints: specific names of what is inside, from the Slack message, a contents label, or clearly recognizable parts
    ("cooling tube", "steering rack", "soldering tips", "heat fins"). Never generic words (box, package, parts, PCBs,
    components, envelope) and never guesses from the box alone. Only for THIS package; empty if unknown.
If the Slack message names items that can't be tied to a specific package in the photo, put them on the first package.

Do not transcribe prices, totals, or account numbers."""

_client: OpenAI | None = None


def _openai() -> OpenAI:
    global _client
    if not has_openai():
        raise RuntimeError('OPENAI_API_KEY is not configured; package arrivals need it to read photos.')
    if _client is None:
        _client = OpenAI(api_key=config.openai.api_key)
    return _client


def _str(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _iso_date(v: Any) -> str | None:
    s = _str(v)
    return s if s and re.fullmatch(r'\d{4}-\d{2}-\d{2}', s) else None


# Words that describe packaging, not contents — the model adds them from looking at a box.
GENERIC_HINT = re.compile(
    r'^(?:(?:small|large|medium|big|multiple|some|various|assorted|misc\.?|bubble[- ]wrapped)\s+)*'
    r'(?:pcbs?|boards?|parts?|components?|electronic components|electronics|items?|stuff|supplies|hardware)$',
    re.I,
)
PACKAGING = re.compile(
    r'\b(?:box(?:es)?|envelopes?|mailers?|packages?|parcels?|corrugated?|cardboard|poster|padded|bubble|tape|labels?|pallets?|packing)\b',
    re.I,
)


def is_specific_hint(hint: str) -> bool:
    h = re.sub(r'\s+', ' ', re.sub(r'\([^)]*\)', ' ', hint)).strip()  # "PCBs (JLCPCB)" is still just "PCBs"
    return len(h) >= 3 and not GENERIC_HINT.search(h) and not PACKAGING.search(h)


def _list(v: Any) -> list[Any]:
    return v if isinstance(v, list) else []


def _parse_package(o: Any) -> Extraction:
    o = o if isinstance(o, dict) else {}
    lines = []
    for l in _list(o.get('lines')):
        l = l if isinstance(l, dict) else {}
        q = l.get('quantity_shipped')
        lines.append(
            SlipLine(
                vendor_part_number=_str(l.get('vendor_part_number')),
                manufacturer_part_number=_str(l.get('manufacturer_part_number')),
                description=_str(l.get('description')),
                quantity_shipped=q if isinstance(q, (int, float)) and not isinstance(q, bool) and math.isfinite(q) else None,
                customer_reference=_str(l.get('customer_reference')),
            )
        )
    order_numbers = []
    for n in _list(o.get('order_numbers')):
        n = n if isinstance(n, dict) else {}
        value = _str(n.get('value')) or ''
        if value:
            order_numbers.append(OrderNumber(n['kind'] if n.get('kind') in ORDER_KINDS else 'other', value))
    hints = [h for h in (_str(x) for x in _list(o.get('item_hints'))) if h]
    return Extraction(
        vendor=_str(o.get('vendor')),
        addressee=_str(o.get('addressee')),
        ship_date=_iso_date(o.get('ship_date')),
        order_numbers=order_numbers,
        tracking_numbers=[t for t in (_str(x) for x in _list(o.get('tracking_numbers'))) if t],
        lines=[l for l in lines if l.vendor_part_number or l.manufacturer_part_number or l.customer_reference or l.description],
        item_hints=[h for h in hints if is_specific_hint(h)][:12],
    )


def parse_scan(raw: Any) -> Scan:
    """Validate the model's JSON into a Scan (strict schema should already hold; never trust it blindly)."""
    o = raw if isinstance(raw, dict) else {}
    scene = o.get('scene') if o.get('scene') in SCENES else 'not_a_delivery'
    packages = [] if scene == 'not_a_delivery' else [_parse_package(p) for p in _list(o.get('packages'))[:6]]
    return Scan(scene=scene, legible=o.get('legible') is True, packages=packages)


def scan_photos(images: list[SlipImage], context: ScanContext) -> Scan:
    said = '\n'.join(
        x
        for x in [
            f'Thread started with: {json.dumps(context.parent_text[:500], ensure_ascii=False)}' if context.parent_text else '',
            f"Message posted with the photo: {json.dumps((context.text or '(no text)')[:500], ensure_ascii=False)}",
        ]
        if x
    )
    content: list[dict[str, Any]] = [{'type': 'input_text', 'text': f'{PROMPT}\n\n{said}'}]
    for img in images:
        content.append(
            {
                'type': 'input_image',
                'image_url': f'data:{img.mime_type};base64,{base64.b64encode(img.data).decode()}',
                'detail': 'high',
            }
        )
    response = _openai().responses.create(
        model=config.arrivals.vision_model,
        reasoning={'effort': 'low'},
        input=[{'role': 'user', 'content': content}],
        text={'format': {'type': 'json_schema', 'name': 'delivery_scan', 'strict': True, 'schema': SCHEMA}},
    )
    return parse_scan(json.loads(response.output_text or '{}'))
