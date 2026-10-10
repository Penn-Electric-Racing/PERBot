import { config } from '../config.js';

/**
 * The REV12 members' time trial leaderboard (race.pennelectricracing.com), read from its Supabase database.
 * `bot_leaderboard` can only be called with the service_role key, which lives on this server.
 */

export interface BoardRow {
  rank: number;
  name: string;
  slack_id: string | null;
  time_ms: number;
  cones: number;
  laps: number;
  set_at: string;
}

export type Period = 'week' | 'all';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function raceConfigured(): boolean {
  return Boolean(config.race.supabaseUrl && config.race.serviceKey);
}

export async function fetchBoard(period: Period, limit = 10, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<BoardRow[]> {
  const since = period === 'week' ? new Date(now - WEEK_MS).toISOString() : null;
  const res = await fetchImpl(`${config.race.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/bot_leaderboard`, {
    method: 'POST',
    headers: {
      apikey: config.race.serviceKey,
      Authorization: `Bearer ${config.race.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ since, lim: limit }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`leaderboard request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as BoardRow[];
}

/** 41234 → "0:41.23" */
export function formatLap(ms: number): string {
  const t = ms / 1000;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
