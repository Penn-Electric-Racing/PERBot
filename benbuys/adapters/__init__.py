"""Vendor adapters for BenBuys: how each vendor's cart and requisition are built.

  registry.py   resolve_adapter, LIVE_VENDORS: the adapters by key
  digikey.py    DigiKey (electrical)
  mcmaster.py   McMaster-Carr (mechanical; a stub, not live)
"""

from .digikey import *
from .mcmaster import *
from .registry import *

__all__ = (
    'digikey_adapter', 'mcmaster_adapter', 'DEFAULT_VENDOR', 'LIVE_VENDORS', 'resolve_adapter',
    'is_vendor_key',
)
