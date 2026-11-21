from arrivals.models import Extraction, SlipLine
from core.purchasing import PurchasingRow
from tests.benbuys.helpers import row as purchasing_row

ARRIVAL_DEFAULTS = dict(
    vendor='DigiKey',
    run_id='',
    arrived='No',
    exported=True,
    submitted_at='2026-09-20',
    ordered_at='2026-09-28T15:00:00.000Z',
)


def row(part_number: str, **o) -> PurchasingRow:
    return purchasing_row(part_number, **{**ARRIVAL_DEFAULTS, **o})


def line(pn: str, qty=1, **o) -> SlipLine:
    return SlipLine(vendor_part_number=pn, quantity_shipped=qty, **o)


def pkg(lines=None, **o) -> Extraction:
    return Extraction(**{'vendor': 'DigiKey', 'lines': lines or [], **o})


BASE = {'u': 'U_POSTER', 'ts': '1760100000.000100'}
