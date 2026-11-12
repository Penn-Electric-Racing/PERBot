from __future__ import annotations

from dataclasses import dataclass

from benbuys.models import VendorAdapter
from benbuys.prep import money


@dataclass
class RequisitionEmail:
    """The requisition email, ready for any transport."""

    from_addr: str
    to: list[str]
    cc: list[str]
    subject: str
    body: str
    approval_required: bool


def build_requisition_email(
    adapter: VendorAdapter,
    requisition_number: str,
    total: float,
    line_count: int,
    from_addr: str,
    cc: list[str],
    approval_threshold: float,
) -> RequisitionEmail:
    """`total` is the BEN order total as typed by the operator; `line_count` the distinct cart lines
    post-aggregation — how BEN counts line items."""
    approval_required = total > approval_threshold
    tag = '[APPROVAL REQUIRED]' if approval_required else '[NO APPROVAL REQUIRED]'
    items = f"{line_count} line item{'' if line_count == 1 else 's'}"
    question = ' Dr. Tertuliano, do you approve?' if approval_required else ''
    paragraphs = [
        'Hi,',
        f'I just placed Requisition {requisition_number} on BenBuys for a {adapter.label} order for {adapter.subteam}, '
        f'and the order total is ${money(total)} ({items}).{question} Thank you for placing the order!',
        f'Best,\n{adapter.signature_name}',
    ]
    return RequisitionEmail(
        from_addr=from_addr,
        to=adapter.email_to,
        cc=cc,
        subject=f'{tag} PER Requisition {requisition_number}',
        body='\n\n'.join(paragraphs),
        approval_required=approval_required,
    )


def render_email(email: RequisitionEmail) -> str:
    """Human-readable rendering for dry runs and the Slack confirmation."""
    return '\n'.join([
        f'From: {email.from_addr}',
        f"To: {', '.join(email.to)}",
        f"Cc: {', '.join(email.cc)}",
        f'Subject: {email.subject}',
        '',
        email.body,
    ])
