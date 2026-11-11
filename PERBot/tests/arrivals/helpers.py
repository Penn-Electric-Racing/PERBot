import dataclasses

from perbot.arrivals.models import ArrivalRow, Extraction, SlipLine

from ..benbuys.helpers import row as purchasing_row

_ARRIVAL_FIELDS = {f.name for f in dataclasses.fields(ArrivalRow)} - {f.name for f in dataclasses.fields(purchasing_row('x'))}


def row(part_number: str, **o) -> ArrivalRow:
    base_overrides = {k: v for k, v in o.items() if k not in _ARRIVAL_FIELDS}
    base = purchasing_row(part_number, **base_overrides)
    fields = {f.name: getattr(base, f.name) for f in dataclasses.fields(base)}
    arrival = dict(
        vendor='DigiKey',
        run_id='',
        arrived='No',
        exported=True,
        submitted_at='2026-09-20',
        ordered_at='2026-09-28T15:00:00.000Z',
    )
    arrival.update({k: v for k, v in o.items() if k in _ARRIVAL_FIELDS})
    return ArrivalRow(**fields, **arrival)


def line(pn: str, qty=1, **o) -> SlipLine:
    return SlipLine(vendor_part_number=pn, quantity_shipped=qty, **o)


def pkg(lines=None, **o) -> Extraction:
    return Extraction(**{'vendor': 'DigiKey', 'lines': lines or [], **o})


BASE = {'u': 'U_POSTER', 'ts': '1760100000.000100'}
