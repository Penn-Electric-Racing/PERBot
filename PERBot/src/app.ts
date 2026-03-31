import { App } from '@slack/bolt';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { indexExists, loadIndex } from './services/index-store.js';
import { searchIndex } from './services/search.js';
import { summarizeSearchResults } from './services/llm.js';
import { buildResultBlocks } from './services/slack-format.js';

const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
});

function cleanMentionText(text: string): string {
  return text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/^\s*PERBot[:,\-]?\s*/i, '')
    .trim();
}

async function ensureIndexReady(): Promise<boolean> {
  return indexExists();
}

async function answerQuery(query: string) {
  if (!(await ensureIndexReady())) {
    return {
      summary: 'I do not have a local Notion index yet. Run `npm run index` first, then try again.',
      results: [],
    };
  }

  const index = await loadIndex();
  const results = await searchIndex(index, query);
  const summary = await summarizeSearchResults(query, results.slice(0, config.app.maxResultsToSummarize));
  return { summary, results };
}

app.command('/dt', async ({ ack, command, client }) => {
  const query = command.text.trim();

  if (!query) {
    await ack({
      response_type: 'ephemeral',
      text: 'Usage: `/dt your question here`\nExample: `/dt REV11 chassis packaging` or `/dt season:REV11 subsystem:chassis cooling`',
    });
    return;
  }

  await ack({ response_type: 'ephemeral', text: `PERBot is searching Notion for: ${query}` });

  try {
    const parent = await client.chat.postMessage({
      channel: command.channel_id,
      text: `PERBot search: ${query}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:mag: *PERBot search started*\n*Query:* \`${query}\``,
          },
        },
      ],
    });

    const { summary, results } = await answerQuery(query);
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: parent.ts,
      text: `PERBot results for: ${query}`,
      blocks: buildResultBlocks(query, summary, results),
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    logger.error('Slash command failed.', error);
    await client.chat.postMessage({
      channel: command.channel_id,
      text: `PERBot hit an error while searching for: ${query}`,
    });
  }
});

app.event('app_mention', async ({ event, client }) => {
  const rawText = 'text' in event ? event.text : '';
  const query = cleanMentionText(rawText);

  if (!query) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: 'Ask me a PER docs question after mentioning me. Example: `@PERBot what changed in REV11 chassis?`',
    });
    return;
  }

  try {
    const { summary, results } = await answerQuery(query);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: `PERBot results for: ${query}`,
      blocks: buildResultBlocks(query, summary, results),
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    logger.error('Mention handler failed.', error);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: 'PERBot hit an error while searching Notion. Check your server logs and make sure the local index exists.',
    });
  }
});

async function main(): Promise<void> {
  await app.start();
  logger.info('⚡️ PERBot is running in Slack Socket Mode.');
  logger.info(`Index path: ${config.app.indexPath}`);
}

main().catch((error) => {
  logger.error('Failed to start PERBot.', error);
  process.exitCode = 1;
});
