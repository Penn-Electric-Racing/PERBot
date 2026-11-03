import { isDev, normalizeNotionId, PROD_NOTION_IDS } from '../env.js';

/**
 * Safety rails for dev-only tooling (src/dev/*). Every dev command that writes to Notion calls
 * this first, so a seed/clean can never run against prod:
 *  - dev mode must be on (PERBOT_ENV=dev / DEV=true / --dev → `.env.dev`, no prod ID fallbacks);
 *  - the target must be set (dev mode has no fallbacks, so empty = not configured);
 *  - the target must not be one of the prod IDs hard-coded in src/config.ts.
 */
export function assertDevTarget(label: string, envVar: string, id: string): string {
  if (!isDev) {
    throw new Error(`Refusing to run: dev tooling only runs in dev mode (PERBOT_ENV=dev). Use the npm run dev:* scripts.`);
  }
  if (!id) {
    throw new Error(`${label} is not configured: set ${envVar} in .env.dev to the sandbox copy's data source ID.`);
  }
  if (PROD_NOTION_IDS.has(normalizeNotionId(id))) {
    throw new Error(`Refusing to run: ${envVar} points at the PROD ${label}. Use the sandbox copy's ID.`);
  }
  return id;
}
