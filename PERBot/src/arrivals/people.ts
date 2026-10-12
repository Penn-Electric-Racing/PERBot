import type { WebClient } from '@slack/web-api';
import { fetchSlackDirectory, notionUserToSlackId } from '../sponsorship/identity.js';
import { logger } from '../utils/logger.js';
import type { ArrivalsNotion } from './notion.js';

/**
 * Requesters (Purchasing `Point of contact`, a Notion person) → Slack user ids, so a reply can
 * @-mention the people who actually know what's in the box, and so they can be DMed when it's
 * confirmed. Email first, then the conservative name match from sponsorship/identity — anyone
 * ambiguous stays a plain name. Rebuilt every 6 hours; a failure leaves names unmentioned.
 */

/** Notion person name (as rows carry it) → Slack user id. */
export type People = Map<string, string>;

const TTL_MS = 6 * 3_600_000;
let cached: { at: number; people: Promise<People> } | null = null;

async function build(client: WebClient, notion: ArrivalsNotion): Promise<People> {
  const [users, slackDir] = await Promise.all([notion.listUsers(), fetchSlackDirectory(client)]);
  const people: People = new Map();
  for (const user of users) {
    if (!user.name || people.has(user.name)) continue;
    const id = await notionUserToSlackId(client, user, slackDir).catch(() => null);
    if (id) people.set(user.name, id);
  }
  logger.info(`Arrivals: ${people.size} of ${users.length} Notion people resolved to Slack.`);
  return people;
}

export function peopleMap(client: WebClient, notion: ArrivalsNotion): Promise<People> {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    const people = build(client, notion);
    cached = { at: Date.now(), people };
    people.catch((err) => {
      logger.warn('Arrivals: could not map requesters to Slack; replies will use plain names', err);
      cached = null;
    });
  }
  return cached.people.catch(() => new Map());
}
