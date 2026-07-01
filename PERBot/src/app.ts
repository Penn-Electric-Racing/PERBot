import { App } from '@slack/bolt';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { indexExists, loadIndex, loadStatus } from './services/index-store.js';
import { downloadIndexFromRelease } from './services/index-downloader.js';
import { searchIndex } from './services/search.js';
import { summarizeSearchResults } from './services/llm.js';
import { buildResultBlocks } from './services/slack-format.js';
import { registerSponsorCommands } from './sponsorship/slack.js';

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

function userCanReindex(userId?: string): boolean {
  if (!userId) return false;
  if (config.slack.reindexAllowedUserIds.length === 0) return true;
  return config.slack.reindexAllowedUserIds.includes(userId);
}

async function ensureIndexReady(): Promise<boolean> {
  return indexExists();
}

function formatStatus(status: Awaited<ReturnType<typeof loadStatus>>): string {
  if (!status) return 'No index status has been recorded yet.';
  const parts = [
    `*Phase:* ${status.phase}`,
    status.message ? `*Message:* ${status.message}` : '',
    status.totalPages ? `*Pages:* ${status.totalPages}` : '',
    status.totalChunks ? `*Chunks:* ${status.totalChunks}` : '',
    status.totalChunkBatches
      ? `*Embedding progress:* ${status.embeddedChunkBatches ?? 0}/${status.totalChunkBatches} batches`
      : '',
    status.generatedAt ? `*Index generated:* ${status.generatedAt}` : '',
    status.completedAt ? `*Completed:* ${status.completedAt}` : '',
    status.failedAt ? `*Failed:* ${status.failedAt}` : '',
    status.lastError ? `*Last error:* ${status.lastError.slice(0, 800)}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

async function answerQuery(query: string) {
  if (!(await ensureIndexReady())) {
    const status = await loadStatus();
    return {
      summary:
        status?.phase === 'embedding' || status?.phase === 'building_pages'
          ? `I am still building the PER Notion index.\n${formatStatus(status)}`
          : 'I do not have a local Notion index yet. Run `/reindex` to start a fresh build.',
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
  channelId?: string;
  threadTs?: string;
  triggerLabel: string;
}) {
  if (reindexInProgress) {
    return false;
  }

  reindexInProgress = true;
  logger.info(`[PERBot] Starting background reindex (${options.triggerLabel})...`);

  const child = spawn(
    'node',
    [
      `--max-old-space-size=${config.app.indexerHeapMb}`,
      '--enable-source-maps',
      'dist/indexer.js',
    ],
    {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    }
  );

  child.on('error', async (error) => {
    reindexInProgress = false;
    logger.error('Background reindex failed to start.', error);

    if (!options.channelId) return;
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

    if (!options.channelId) return;
    try {
      await app.client.chat.postMessage({
        channel: options.channelId,
        thread_ts: options.threadTs,
        text: success
          ? ':white_check_mark: PERBot finished reindexing Notion successfully.'
          : ':x: PERBot reindexing failed. Run `/indexstatus` and check Render logs for details.',
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

app.command('/anon', async ({ ack, command, client, respond }) => {
  const allowedChannels = config.slack.anonAllowedChannels;
  if (!allowedChannels.includes(command.channel_name)) {
    await ack({
      response_type: 'ephemeral',
      text: `\`/anon\` can only be used in: ${allowedChannels
        .map((name) => `#${name}`)
        .join(', ')}`,
    });
    return;
  }

  const text = command.text.trim();

  if (!text) {
    await ack({
      response_type: 'ephemeral',
      text:
        'Usage: `/anon your message`\nPERBot will post your message in this channel without revealing who sent it.',
    });
    return;
  }

  await ack();

  try {
    await client.chat.postMessage({
      channel: command.channel_id,
      text: `:bust_in_silhouette: Anonymous: ${text}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: ':bust_in_silhouette: Sent anonymously via `/anon`',
            },
          ],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });

    await respond({
      response_type: 'ephemeral',
      text: ':white_check_mark: Your anonymous message was posted.',
    });
  } catch (error) {
    // Log only the error itself — never the sender or message text, so
    // anonymity holds even in server logs.
    logger.error('Anonymous message post failed.', error);
    await respond({
      response_type: 'ephemeral',
      text:
        ':x: PERBot could not post your anonymous message. If this is a private channel, invite @PERBot to it first and try again.',
    });
  }
});

app.command('/reindex', async ({ ack, command, client }) => {
  await ack({
    response_type: 'ephemeral',
    text: 'PERBot received your reindex request.',
  });

  if (!userCanReindex(command.user_id)) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: 'You are not allowed to run `/reindex` for PERBot.',
    });
    return;
  }

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

app.command('/indexstatus', async ({ ack, command, client }) => {
  await ack();
  const status = await loadStatus();
  const text = formatStatus(status);
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text,
  });
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
        'PERBot hit an error while searching Notion. Check Render logs and try `/indexstatus`.',
    });
  }
});

registerSponsorCommands(app);

async function main(): Promise<void> {
  logger.info('[PERBot] Starting Slack Socket Mode...');
  await app.start();
  logger.info('⚡️ PERBot is running in Slack Socket Mode.');
  logger.info(`Index path: ${config.app.indexPath}`);

  if (!(await ensureIndexReady())) {
    await downloadIndexFromRelease();
  }

  if (config.app.autoBootstrapOnMissingIndex && !(await ensureIndexReady())) {
    const status = await loadStatus();
    if (status?.phase !== 'embedding' && status?.phase !== 'building_pages') {
      startBackgroundReindex({ triggerLabel: 'auto-bootstrap' });
    }
  }
}

main().catch((error) => {
  logger.error('Failed to start PERBot.', error);
  process.exitCode = 1;
});
