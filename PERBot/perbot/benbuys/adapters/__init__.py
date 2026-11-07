from __future__ import annotations

from ..models import VendorAdapter
from .digikey import digikey_adapter
from .mcmaster import mcmaster_adapter

DEFAULT_VENDOR = 'digikey'

_ADAPTERS: dict[str, VendorAdapter] = {digikey_adapter.key: digikey_adapter, mcmaster_adapter.key: mcmaster_adapter}

# Vendors that are actually usable from Slack (the McMaster stub is registered but not live).
LIVE_VENDORS: list[str] = [digikey_adapter.key]


def resolve_adapter(key: str | None) -> VendorAdapter | None:
    k = (key if key is not None else DEFAULT_VENDOR).strip().lower()
    adapter = _ADAPTERS.get(k)
    return adapter if adapter and k in LIVE_VENDORS else None


def is_vendor_key(token: str) -> bool:
    return token.strip().lower() in _ADAPTERS
