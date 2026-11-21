"""`/benbuys`: prep a BEN purchase from the ready Purchasing rows, then mark it done."""
from __future__ import annotations

import logging

from benbuys.adapters.registry import LIVE_VENDORS, resolve_adapter
from benbuys.slack import USAGE, BenbuysDeps, handle_done, handle_prep, parse_benbuys
from core.feature import Feature, command

logger = logging.getLogger(__name__)

__all__ = ['BenBuys']


class BenBuys(Feature):
    name = 'benbuys'

    def __init__(self, deps: BenbuysDeps | None = None):
        self.deps = deps or BenbuysDeps()
        if not self.deps.mailer:
            logger.warning('BenBuys: no email transport configured — `/benbuys done` will only work with --no-send.')

    @command('/benbuys')
    def benbuys(self, ack, command, respond) -> None:
        ack()
        parsed = parse_benbuys(command.get('text') or '')
        if parsed.kind == 'help':
            respond(response_type='ephemeral', text=USAGE)
            return
        adapter = resolve_adapter(parsed.vendor)
        if not adapter:
            respond(response_type='ephemeral', text=f"Vendor \"{parsed.vendor}\" isn’t live yet. Available: {', '.join(LIVE_VENDORS)}.")
            return
        try:
            if parsed.kind == 'prep':
                handle_prep(self.deps, adapter, command['user_id'], respond)
            elif parsed.error:
                respond(response_type='ephemeral', text=f'{parsed.error}\nUsage: `/benbuys done <requisition#> <BEN total>`')
            else:
                handle_done(self.deps, adapter, command['user_id'], parsed, respond)
        except Exception as err:
            logger.error(f'/benbuys {parsed.kind} failed', exc_info=err)
            respond(response_type='ephemeral', text=f'✗ /benbuys {parsed.kind} hit an error: {err}. Check the PERBot logs.')
