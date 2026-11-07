import itertools

from perbot.benbuys.models import PurchasingRow, VendorAdapter
from perbot.benbuys.reference import truncate_reference
from perbot.utils.text import js_number

# A DigiKey-shaped adapter that doesn't touch config.
test_adapter = VendorAdapter(
    key='digikey',
    label='DigiKey',
    match_formula='Electrical BENBuys',
    subteam='electrical',
    ben_description='PER electrical purchase',
    ben_justification="This is a purchase for PER's electrical subteam.",
    operator_slack_ids=['U_OPERATOR'],
    signature_name='Katherine Shen',
    email_to=['purchasing@engineering.upenn.edu'],
    format_cart_lines=lambda lines: '\n'.join(f'{js_number(l.quantity)}, {l.part_number}, {l.reference}' for l in lines),
    reference_field=lambda pn, rows: truncate_reference(pn, rows, 35),
    part_number_warning=lambda pn: None if pn.endswith('-ND') else 'may be a manufacturer part number — DigiKey may pick different packaging',
)

_seq = itertools.count(1)


def row(part_number: str, **overrides) -> PurchasingRow:
    n = next(_seq)
    description = overrides.get('sanitized_description', f'PART {n}')
    base = dict(
        id=f'page-{n}',
        url=f'https://notion.so/page-{n}',
        name=description,
        part_number=part_number,
        quantity=1,
        unit_cost=1,
        subsystems=['Misc (elec)'],
        point_of_contact=[],
        order_batch='Order 1',
        link='https://www.digikey.com/x',
        sanitized_description=description,
        notes='',
        readiness='✅ Ready',
        include_in_next_order=False,
    )
    return PurchasingRow(**{**base, **overrides})
