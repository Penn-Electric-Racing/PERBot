"""Deliveries: a photo in ARRIVALS_CHANNEL is matched to its Purchasing order and answered with a
package card the receiver taps to mark it arrived.

  feature.py    Arrivals: the photo listener, the card buttons and the nudge sweep
  views.py      PackageCardView: the card buttons (Mark arrived, Not this order, Other orders, Undo)
  slack.py      the channel handlers: photos, replies, clicks, @mentions, the sweep
  pipeline.py   one message with photos → scan → resolutions → reply
  extract.py    photos + text → a Scan (OpenAI vision)
  resolve.py    a Scan → Resolutions, strongest evidence first
  match.py      packing slip → open Purchasing rows
  pick.py       text evidence → the likely order (LLM)
  orders.py     the open orders a package could belong to
  people.py     requesters (Notion people) → Slack user ids
  blocks.py     Block Kit for the reply and card, and the button value codec
  notion.py     Purchasing access: open rows, mark / unmark arrived
  models.py     shared types

Run with `python -m`:

  cli.py        `python -m arrivals.cli`: read-only runs of the pipeline
"""

from .blocks import *
from .extract import *
from .feature import *
from .match import *
from .models import *
from .notion import *
from .orders import *
from .people import *
from .pick import *
from .pipeline import *
from .resolve import *
from .slack import *
from .views import *

__all__ = (
    'ARRIVAL_ACTION_IDS', 'ARRIVAL_ACTION_RE', 'CARD_BLOCK_RE', 'ACTIONS_BLOCK_PREFIX',
    'CHOICE_BLOCK_PREFIX', 'MAX_VALUE_CHARS', 'MAX_LISTED', 'MAX_PACKAGES', 'MAX_OPTIONS',
    'MAX_ALTERNATIVES', 'CARD_LISTED', 'ET', 'Block', 'ArrivalButtonValue', 'compact',
    'encode_value', 'decode_value', 'target_ids', 'these_value', 'order_value', 'who',
    'short_date', 'item_line', 'row_detail', 'CardInput', 'order_card', 'match_card',
    'ASK_AGAIN', 'guess_card', 'Reply', 'ReplyContext', 'text_names_vendor', 'SLIP_PLEASE',
    'build_reply', 'lead_time_line', 'settle_blocks', 'package_key', 'card_index', 'is_card',
    'replace_card', 'settle_card', 'arrival_dm', 'reminder_dm', 'SlipImage', 'ScanContext',
    'ORDER_KINDS', 'SCENES', 'LINE_SCHEMA', 'PACKAGE_SCHEMA', 'PROMPT', 'GENERIC_HINT',
    'PACKAGING', 'is_specific_hint', 'parse_scan', 'scan_photos', 'Arrivals', 'VENDOR_ALIASES',
    'VENDOR_NAMES', 'vendor_display', 'vendor_key', 'row_vendor_key', 'vendors_compatible',
    'part_codes', 'match_slip', 'OrderNumberKind', 'Scene', 'SlipLine', 'OrderNumber',
    'Extraction', 'Scan', 'MatchConfidence', 'LineMatch', 'SlipMatch', 'OpenOrder',
    'Resolution', 'ARRIVED_YES', 'OPTIONAL_COLUMNS', 'ArrivalWrite', 'ArrivalsNotion', 'DAY_S',
    'STALE_DAYS', 'MAX_AGE_DAYS', 'iso_time', 'eligible_rows', 'order_key', 'is_stale',
    'group_orders', 'orders_for_vendor', 'addressee_matches', 'rank_orders', 'People', 'TTL_S',
    'people_map', 'Pick', 'MAX_ORDERS', 'MAX_PICKS', 'MAX_ITEMS', 'PickPrompt',
    'build_pick_prompt', 'PICK_SCHEMA', 'parse_picks', 'stem', 'VENDOR_WORDS', 'STOP', 'terms',
    'is_generic', 'ground_picks', 'pick_orders', 'DIRECT_TYPES', 'MAX_IMAGES',
    'DeliveryMessage', 'DeliveryResult', 'process_delivery', 'resolution_key', 'is_image',
    'load_images', 'slack_name', 'with_names', 'parent_text', 'Picker', 'resolve_package',
    'resolve_scan', 'AWAIT_S', 'thread_orders', 'handle_photo', 'handle_arrivals_mention',
    'SWEEP_WINDOW_S', 'SWEEP_EVERY_S', 'SWEEP_MIN_AGE_S', 'is_photo_post', 'already_answered',
    'recent_photo_posts', 'REMIND_AFTER_S', 'UNDO_WINDOW_S', 'NO_PACKAGE', 'sweep_once',
    'handle_message', 'handle_click', 'PackageCardView',
)
