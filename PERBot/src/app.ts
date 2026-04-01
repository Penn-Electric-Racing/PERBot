import { App } from '@slack/bolt';
import { spawn } from 'node:child_process';
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

let reindexInProgress = false;

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
      summary:
        'I do not have a local Notion index yet, or indexing is still in progress. Try again in a bit, or run `/reindex` to start a fresh build.',
      results: [],
    };
  }

  const index = await loadIndex();
  const results = await searchIndex(index, query);
  const summary = await summarizeSearchResults(
    query,
    results.slice(0, config.app.maxResultsToSummarize)
  );
  return { summary, results };
}

function startBackgroundReindex(options: {
  channelId: string;
  threadTs?: string;
  triggerLabel: string;
}) {
  if (reindexInProgress) {
    return false;
  }

  reindexInProgress = true;

  logger.info(`[PERBot] Starting background reindex (${options.triggerLabel})...`);

  const child = spawn('node', ['--enable-source-maps', 'dist/indexer.js'], {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });

  child.on('error', async (error) => {
    reindexInProgress = false;
    logger.error('Background reindex failed to start.', error);

    try {
      await app.client.chat.postMessage({
        channel: options.channelId,
        thread_ts: options.threadTs,
        text: ':x: PERBot failed to start the reindex job. Check the Render logs.',
      });
    } catch (postError) {
      logger.error('Failed to post reindex startup failure message.', postError);
    }
  });

  child.on('exit', async (code, signal) => {
    reindexInProgress = false;

    const success = code === 0;
    if (success) {
      logger.info('[PERBot] Background reindex finished successfully.');
    } else {
      logger.error(
        `[PERBot] Background reindex exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`
      );
    }

    try {
      await app.client.chat.postMessage({
        channel: options.channelId,
        thread_ts: options.threadTs,
        text: success
          ? ':white_check_mark: PERBot finished reindexing Notion successfully.'
          : ':x: PERBot reindexing failed. Check the Render logs for details.',
      });
    } catch (postError) {
      logger.error('Failed to post reindex completion message.', postError);
    }
  });

  return true;
}

app.command('/dt', async ({ ack, command, client }) => {
  const query = command.text.trim();

  if (!query) {
    await ack({
      response_type: 'ephemeral',
      text:
        'Usage: `/dt your question here`\nExample: `/dt REV11 chassis packaging` or `/dt season:REV11 subsystem:chassis cooling`',
    });
    return;
  }

  await ack({
    response_type: 'ephemeral',
    text: `PERBot is searching Notion for: ${query}`,
  });

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

app.command('/reindex', async ({ ack, command, client }) => {
  await ack({
    response_type: 'ephemeral',
    text: 'PERBot received your reindex request.',
  });

  try {
    const parent = await client.chat.postMessage({
      channel: command.channel_id,
      text: 'PERBot reindex request',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':arrows_counterclockwise: *PERBot reindex requested*\nStarting a background rebuild of the local Notion index.',
          },
        },
      ],
    });

    const started = startBackgroundReindex({
      channelId: command.channel_id,
      threadTs: parent.ts,
      triggerLabel: '/reindex',
    });

    if (!started) {
      await client.chat.postMessage({
        channel: command.channel_id,
        thread_ts: parent.ts,
        text: ':warning: A PERBot reindex is already in progress.',
      });
      return;
    }

    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: parent.ts,
      text: ':hourglass_flowing_sand: Reindex started. PERBot will post here when it finishes.',
    });
  } catch (error) {
    logger.error('Reindex command failed.', error);
    await client.chat.postMessage({
      channel: command.channel_id,
      text: ':x: PERBot could not start the reindex job.',
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
      text:
        'Ask me a PER docs question after mentioning me. Example: `@PERBot what changed in REV11 chassis?`',
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
      text:
        'PERBot hit an error while searching Notion. Check the Render logs and make sure the local index exists.',
    });
  }
});

async function main(): Promise<void> {
  logger.info('[PERBot] Starting Slack Socket Mode...');
  await app.start();
  logger.info('⚡️ PERBot is running in Slack Socket Mode.');
  logger.info(`Index path: ${config.app.indexPath}`);
}

main().catch((error) => {
  logger.error('Failed to start PERBot.', error);
  process.exitCode = 1;
});
