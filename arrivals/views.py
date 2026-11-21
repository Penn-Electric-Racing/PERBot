"""The package card's buttons: Mark arrived, Not this order, Other orders…, Undo."""
from __future__ import annotations

from arrivals.blocks import ARRIVAL_ACTION_IDS, ARRIVAL_ACTION_RE
from arrivals.slack import handle_click
from core.ui import Interaction, View, button

__all__ = ['PackageCardView']


class PackageCardView(View):
    @button(ARRIVAL_ACTION_RE)
    async def card_action(self, interaction: Interaction) -> None:
        # A checkbox toggled: its state rides along with the next button tap.
        if interaction.action_id == ARRIVAL_ACTION_IDS['items']:
            return
        await handle_click(interaction.body, interaction.action, interaction.respond, interaction.client)
