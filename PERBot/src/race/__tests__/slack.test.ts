import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLap, fetchBoard, type BoardRow } from '../board.js';
import { boardMessage, boardText, parseRace } from '../slack.js';

const rows: BoardRow[] = [
  { rank: 1, name: 'Ben Ito', slack_id: 'UBEN', time_ms: 41234, cones: 0, laps: 6, set_at: '2026-10-09T00:00:00Z' },
  { rank: 2, name: 'Ada Park', slack_id: 'UADA', time_ms: 43010, cones: 1, laps: 1, set_at: '2026-10-09T00:00:00Z' },
  { rank: 4, name: 'Cam Lee', slack_id: null, time_ms: 61000, cones: 2, laps: 3, set_at: '2026-10-09T00:00:00Z' },
];

test('parseRace: week by default; all / share in any order; help', () => {
  assert.deepEqual(parseRace(''), { kind: 'board', period: 'week', share: false });
  assert.deepEqual(parseRace('all'), { kind: 'board', period: 'all', share: false });
  assert.deepEqual(parseRace(' Share  ALL '), { kind: 'board', period: 'all', share: true });
  assert.deepEqual(parseRace('post'), { kind: 'board', period: 'week', share: true });
  assert.equal(parseRace('help').kind, 'help');
});

test('formatLap: minutes, two decimals, padded seconds', () => {
  assert.equal(formatLap(41234), '0:41.23');
  assert.equal(formatLap(65000), '1:05.00');
  assert.equal(formatLap(9990), '0:09.99');
});

test('boardText: private reply uses mentions, medals, cones and laps, and your place', () => {
  const t = boardText(rows, 'week', { share: false, viewer: 'UADA' });
  assert.match(t, /last 7 days/);
  assert.match(t, /🥇 <@UBEN> {2}`0:41.23` {2}_6 laps_/);
  assert.match(t, /🥈 <@UADA> {2}`0:43.01` {2}_\+1 cone, 1 lap_/);
  assert.match(t, /4\. Cam Lee/);   // no Slack id: plain name
  assert.match(t, /You're P2 with 0:43.01\./);
  assert.match(boardText(rows, 'all', { share: false, viewer: 'UZZZ' }), /not on this board yet/);
});

test('boardText: shared posts use names (no pings) and no personal footer', () => {
  const t = boardText(rows, 'all', { share: true, viewer: 'UADA' });
  assert.match(t, /all time/);
  assert.match(t, /🥇 Ben Ito/);
  assert.doesNotMatch(t, /<@/);
  assert.doesNotMatch(t, /You're P/);
});

test('boardText / boardMessage: empty board invites a first lap; share posts in channel', () => {
  assert.match(boardText([], 'week', { share: false }), /No laps this week/);
  assert.equal(boardMessage(rows, 'week', { share: true }).response_type, 'in_channel');
  assert.equal(boardMessage(rows, 'week', { share: false }).response_type, 'ephemeral');
});

test('fetchBoard: calls the bot RPC with the service key and a 7-day window', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify(rows), { status: 200 }); }) as unknown as typeof fetch;
  const now = Date.parse('2026-10-10T00:00:00Z');
  const out = await fetchBoard('week', 10, now, fake);
  assert.equal(out.length, 3);
  assert.match(seen!.url, /\/rest\/v1\/rpc\/bot_leaderboard$/);
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { since: '2026-10-03T00:00:00.000Z', lim: 10 });
  await fetchBoard('all', 10, now, fake);
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { since: null, lim: 10 });
});
