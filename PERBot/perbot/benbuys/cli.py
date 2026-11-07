"""Local checks without Slack (run from PERBot/ with .env set):
  python -m perbot.benbuys.cli prep [vendor]        read-only: prints the three prep blocks
  python -m perbot.benbuys.cli email you@upenn.edu  sends a sample requisition email to YOU only
                                                    (verifies the Gmail OAuth creds; no Notion writes)
"""
from __future__ import annotations

import dataclasses
import sys

from ..config import config
from .adapters import resolve_adapter
from .email import build_requisition_email, render_email
from .mailer import create_mailer
from .notion import PurchasingNotion
from .prep import build_prep, format_prep


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    mode = args[0] if args else 'prep'
    arg = args[1] if len(args) > 1 else None
    adapter = resolve_adapter(arg if mode == 'prep' else None)
    if not adapter:
        raise RuntimeError(f'Unknown or non-live vendor "{arg}".')

    if mode == 'prep':
        selection = PurchasingNotion().select_rows(adapter)
        prep = build_prep(adapter, selection.ready, selection.not_ready)
        blocks = format_prep(adapter, prep, config.benbuys.approval_threshold)
        print(f'--- BLOCK 1: cart ({len(prep.lines)} lines) ---\n{blocks.cart}\n')
        print(f'--- BLOCK 2: BEN ---\n{blocks.ben}\n')
        print(f'--- BLOCK 3: summary ---\n{blocks.summary}')
        return

    if mode == 'email':
        if not arg or '@' not in arg:
            raise RuntimeError('Usage: python -m perbot.benbuys.cli email you@upenn.edu')
        mailer = create_mailer()
        if not mailer:
            raise RuntimeError('No email transport configured (BENBUYS_MAIL_TRANSPORT + creds).')
        email = build_requisition_email(
            adapter,
            requisition_number='0000000',
            total=123.45,
            line_count=3,
            from_addr=config.benbuys.from_addr,
            cc=[],
            approval_threshold=config.benbuys.approval_threshold,
        )
        test = dataclasses.replace(email, to=[arg], subject=f'[TEST — ignore] {email.subject}')
        print(render_email(test))
        msg_id = mailer.send(test)
        print(f"\nSent via {mailer.name}{f' (id {msg_id})' if msg_id else ''}.")
        return

    raise RuntimeError(f'Unknown mode "{mode}" — use prep or email.')


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        print(err, file=sys.stderr)
        sys.exit(1)
