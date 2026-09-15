import type { VendorAdapter } from '../types.js';
import { digikeyAdapter } from './digikey.js';
import { mcmasterAdapter } from './mcmaster.js';

export const DEFAULT_VENDOR = 'digikey';

const ADAPTERS: Record<string, VendorAdapter> = {
  [digikeyAdapter.key]: digikeyAdapter,
  [mcmasterAdapter.key]: mcmasterAdapter,
};

/** Vendors that are actually usable from Slack (the McMaster stub is registered but not live). */
export const LIVE_VENDORS: string[] = [digikeyAdapter.key];

export function resolveAdapter(key: string | undefined): VendorAdapter | null {
  const k = (key ?? DEFAULT_VENDOR).trim().toLowerCase();
  const adapter = ADAPTERS[k];
  return adapter && LIVE_VENDORS.includes(k) ? adapter : null;
}

export function isVendorKey(token: string): boolean {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, token.trim().toLowerCase());
}
