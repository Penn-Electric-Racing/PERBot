from __future__ import annotations

import dataclasses
from typing import Any

from sponsorship.models import PipelineRow

_BASE = PipelineRow(
    id='p1',
    url='https://notion.so/p1',
    company='Acme',
    stage='Contacted',
    dri_user_ids=['u1'],
    notes='',
    created_time='2026-09-01T12:00:00.000Z',
)


def deal(**over: Any) -> PipelineRow:
    """A Pipeline row with test defaults; keyword overrides replace fields."""
    return dataclasses.replace(_BASE, **{'dri_user_ids': list(_BASE.dri_user_ids), **over})
