import dotenv from 'dotenv';

/**
 * Dev mode: a separate PERBot instance (its own Slack app + its own Notion workspace) for testing.
 * Turn it on with PERBOT_ENV=dev, DEV=true, or a `--dev` CLI arg (e.g. `npm run dev:test`).
 *
 * In dev mode:
 *  - env is loaded from `.env.dev` instead of `.env`, so prod tokens are never picked up by accident;
 *  - none of the hard-coded prod Notion IDs/URLs are used as fallbacks — each one must be set in
 *    `.env.dev` to point at the test workspace, otherwise that feature sees an empty ID;
 *  - the local index lives in ./data-dev and the GitHub index release is `notion-index-dev`.
 */
function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

export const isDev =
  (process.env.PERBOT_ENV ?? '').trim().toLowerCase() === 'dev' ||
  truthy(process.env.DEV) ||
  process.argv.includes('--dev');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || (isDev ? '.env.dev' : '.env') });

/** Prod-only fallback (a Notion ID/URL in the prod workspace): dev mode never falls back to it. */
export function prodDefault(prodValue: string): string {
  return isDev ? '' : prodValue;
}
