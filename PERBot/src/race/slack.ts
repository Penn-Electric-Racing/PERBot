import type { App, RespondArguments } from '@slack/bolt';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { fetchBoard, formatLap, raceConfigured, type BoardRow, type Period } from './board.js';

/**
 * `/race` — the REV12 members' time trial leaderboard.
 *   /race            top 10 of the last 7 days, just for you (with your own best)
 *   /race all        all time
 *   /race share      post the board in this channel (add "all" for all time)
 * Shared posts use plain names so nobody gets pinged; private replies use @mentions (which don't notify).
 */

export interface ParsedRace {
  kind: 'board' | 'help';
  period: Period;
  share: boolean;
}

export function parseRace(text: string): ParsedRace {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.some((w) => w === 'help' || w === '?')) return { kind: 'help', period: 'week', share: false };
  return {
    kind: 'board',
    period: words.some((w) => w === 'all' || w === 'alltime' || w === 'all-time') ? 'all' : 'week',
    share: words.includes('share') || words.includes('post'),
  };
}

export const USAGE = [
  '*REV12 time trial*',
  '• `/race`: the fastest laps of the last 7 days',
  '• `/race all`: the all-time board',
  '• `/race share`: post the board in this channel (add `all` for all time)',
].join('\n');

const MEDALS = ['🥇', '🥈', '🥉'];

export function boardText(rows: BoardRow[], period: Period, opts: { share: boolean; viewer?: string }): string {
  const title = period === 'week' ? '*REV12 time trial: last 7 days*' : '*REV12 time trial: all time*';
  if (!rows.length) return `${title}\nNo laps ${period === 'week' ? 'this week' : 'yet'}. Be the first: ${config.race.siteUrl}`;
  const who = (r: BoardRow) => (!opts.share && r.slack_id ? `<@${r.slack_id}>` : r.name);
  const lines = rows.map((r) => {
    const place = MEDALS[r.rank - 1] ?? `${r.rank}.`;
    const extra = [r.cones ? `+${r.cones} cone${r.cones > 1 ? 's' : ''}` : '', `${r.laps} lap${r.laps > 1 ? 's' : ''}`].filter(Boolean).join(', ');
    return `${place} ${who(r)}  \`${formatLap(r.time_ms)}\`  _${extra}_`;
  });
  const mine = opts.viewer ? rows.find((r) => r.slack_id === opts.viewer) : undefined;
  const footer = opts.share ? '' : mine ? `\nYou're P${mine.rank} with ${formatLap(mine.time_ms)}.` : '\nYou’re not on this board yet.';
  return [title, ...lines].join('\n') + footer;
}

export function boardMessage(rows: BoardRow[], period: Period, opts: { share: boolean; viewer?: string }): RespondArguments {
  const text = boardText(rows, period, opts);
  return {
    response_type: opts.share ? 'in_channel' : 'ephemeral',
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: [{ type: 'button', text: { type: 'plain_text', text: rows.length ? 'Beat these times' : 'Race now' }, url: config.race.siteUrl, style: 'primary', action_id: 'race_open' }],
      },
    ],
  };
}

export function registerRaceCommand(app: App, load: typeof fetchBoard = fetchBoard): void {
  // the button is a plain link; Slack still sends an action, which needs an ack
  app.action('race_open', async ({ ack }) => { await ack(); });

  app.command('/race', async ({ ack, command, respond }) => {
    await ack();
    const parsed = parseRace(command.text);
    if (parsed.kind === 'help') {
      await respond({ response_type: 'ephemeral', text: USAGE });
      return;
    }
    if (!raceConfigured()) {
      await respond({ response_type: 'ephemeral', text: `The time trial leaderboard isn’t connected yet (RACE_SUPABASE_URL / RACE_SUPABASE_SERVICE_KEY). You can still race at ${config.race.siteUrl}` });
      return;
    }
    try {
      const rows = await load(parsed.period);
      await respond(boardMessage(rows, parsed.period, { share: parsed.share, viewer: command.user_id }));
    } catch (err) {
      logger.error('/race failed', err);
      await respond({ response_type: 'ephemeral', text: `✗ Couldn’t load the leaderboard: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
