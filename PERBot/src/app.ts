import { App } from '@slack/bolt';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import {
  assembleIndex,
  getLoadedIndex,
  indexExists,
  loadIndex,
  loadStatus,
  readIndexFiles,
  setLoadedIndex,
  type LoadedIndex,
} from './services/index-store.js';
import { downloadIndexFromRelease, fetchIndexStamp } from './services/index-downloader.js';
import { contextForResult, searchIndex } from './services/search.js';
import { answerFromSources, classifyMention, summarizeThread, type ThreadMessage } from './services/llm.js';
import { buildResultBlocks } from './services/slack-format.js';
import { registerOpsTaskActions } from './opsTasks/actions.js';
import { assignFromMention, registerAssignCommand, registerAssignShortcut } from './opsTasks/assign.js';
import { registerSponsorActions } from './sponsorship/actions.js';
import { registerSponsorCommands } from './sponsorship/slack.js';
import { registerBenbuysCommand } from './benbuys/slack.js';

const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
});

let reindexInProgress = false;
/** `updated_at` of the release asset the loaded index came from; drives the hourly refresh. */
let loadedStamp: string | null = null;
/** One in-flight load at a time: concurrent /dt calls during startup all await the same promise. */
let loading: Promise<LoadedIndex | null> | null = null;

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

function formatStatus(status: Awaited<ReturnType<typeof loadStatus>>): string {
  const loaded = getLoadedIndex();
  const parts = [
    loaded
      ? `*Loaded index:* ${loaded.index.pages.length.toLocaleString()} pages, ${loaded.index.chunks.length.toLocaleString()} chunks, generated ${loaded.index.generatedAt}`
      : '*Loaded index:* none',
  ];
  if (!status) {
    parts.push('No index build status has been recorded on this machine.');
    return parts.join('\n');
  }
  parts.push(
    `*Last build phase:* ${status.phase}`,
    status.message ? `*Message:* ${status.message}` : '',
    status.totalPages ? `*Pages:* ${status.totalPages}` : '',
    status.totalChunks ? `*Chunks:* ${status.totalChunks}` : '',
    status.totalChunkBatches
      ? `*Embedding progress:* ${status.embeddedChunkBatches ?? 0}/${status.totalChunkBatches} batches (${status.reusedEmbeddings ?? 0} reused)`
      : '',
    status.completedAt ? `*Completed:* ${status.completedAt}` : '',
    status.failedAt ? `*Failed:* ${status.failedAt}` : '',
    status.lastError ? `*Last error:* ${status.lastError.slice(0, 800)}` : ''
  );
  return parts.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Index lifecycle: load once, hot-swap when the nightly release updates.
// ---------------------------------------------------------------------------------------------

async function ensureIndexLoaded(): Promise<LoadedIndex | null> {
  const cached = getLoadedIndex();
  if (cached) return cached;
  if (!loading) {
    loading = loadOrDownload().finally(() => {
      loading = null;
    });
  }
  return loading;
}

async function loadOrDownload(): Promise<LoadedIndex | null> {
  if (!(await indexExists())) {
    const dl = await downloadIndexFromRelease();
    if (!dl) return null;
    loadedStamp = dl.stamp;
  }
  try {
    const loaded = await loadIndex();
    logger.info(
      `Index loaded: ${loaded.index.pages.length} pages, ${loaded.index.chunks.length} chunks (generated ${loaded.index.generatedAt}).`
    );
    if (!loadedStamp) loadedStamp = await fetchIndexStamp();
    return loaded;
  } catch (err) {
    // A half-replaced pair (download overlapping the nightly upload) would otherwise wedge the bot:
    // the files exist, so nothing re-downloads. Drop them so the next call fetches a fresh pair.
    logger.error('Index files exist but could not be loaded; discarding them.', err);
    await fs.unlink(config.app.indexPath).catch(() => undefined);
    await fs.unlink(config.app.embeddingsPath).catch(() => undefined);
    loadedStamp = null;
    return null;
  }
}

async function refreshIndexIfNewer(): Promise<void> {
  if (reindexInProgress) return;
  const stamp = await fetchIndexStamp();
  if (!stamp || stamp === loadedStamp) return;

  logger.info(`Release index updated (${stamp}); downloading the new one.`);
  const next = { indexPath: `${config.app.indexPath}.next`, embeddingsPath: `${config.app.embeddingsPath}.next` };
  const dl = await downloadIndexFromRelease(next);
  if (!dl) return;
  try {
    // Parse the new files first (cheap to fail), then swap the files into place and rebuild the
    // in-memory index with the old one already released — holding both plus BM25 scratch would
    // roughly triple the heap on a 512 MB worker. Queries during the ~1 s rebuild await `loading`.
    const { index, embeddings } = await readIndexFiles(next.indexPath, next.embeddingsPath);
    await fs.rename(next.indexPath, config.app.indexPath);
    await fs.rename(next.embeddingsPath, config.app.embeddingsPath);
    loadedStamp = dl.stamp;
    setLoadedIndex(null);
    loading = Promise.resolve(assembleIndex(index, embeddings)).then((loaded) => {
      setLoadedIndex(loaded);
      return loaded;
    });
    await loading.finally(() => {
      loading = null;
    });
    logger.info(`Swapped in index generated ${index.generatedAt} (${index.pages.length} pages).`);
  } catch (err) {
    logger.error('New index could not be loaded; keeping the current one.', err);
    await fs.unlink(next.indexPath).catch(() => undefined);
    await fs.unlink(next.embeddingsPath).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

interface Answer {
  summary: string;
  results: Awaited<ReturnType<typeof searchIndex>>['results'];
  meta: { weak?: boolean; indexedPages?: number; generatedAt?: string };
}

async function answerQuery(query: string): Promise<Answer> {
  const loaded = await ensureIndexLoaded();
  if (!loaded) {
    const status = await loadStatus();
    return {
      summary:
        status?.state === 'indexing'
          ? `I am still building the PER Notion index.\n${formatStatus(status)}`
          : 'I do not have a search index loaded yet. Run `/reindex`, or check that the nightly index build succeeded.',
      results: [],
      meta: {},
    };
  }

  const { results, weak } = await searchIndex(loaded, query);
  const sources = results.slice(0, config.app.maxResultsToSummarize).map((r, i) => ({
    n: i + 1,
    title: r.page.title,
    pathText: r.page.pathText,
    url: r.page.url,
    isHistorical: r.page.isHistorical,
    revNumber: r.page.revNumber,
    text: contextForResult(loaded, r, i === 0 ? 2600 : 1600),
  }));
  const summary = await answerFromSources(query, sources, weak);
  return {
    summary,
    results,
    meta: { weak, indexedPages: loaded.index.pages.length, generatedAt: loaded.index.generatedAt },
  };
}

function startBackgroundReindex(options: { channelId?: string; threadTs?: string; triggerLabel: string }) {
  if (reindexInProgress) return false;

  reindexInProgress = true;
  logger.info(`[PERBot] Starting background reindex (${options.triggerLabel})...`);

  const child = spawn(
    'node',
    [`--max-old-space-size=${config.app.indexerHeapMb}`, '--enable-source-maps', 'dist/indexer.js'],
    { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' }
  );

  const notify = async (text: string) => {
    if (!options.channelId) return;
    try {
      await app.client.chat.postMessage({ channel: options.channelId, thread_ts: options.threadTs, text });
    } catch (postError) {
      logger.error('Failed to post reindex message.', postError);
    }
  };

  child.on('error', async (error) => {
    reindexInProgress = false;
    logger.error('Background reindex failed to start.', error);
    await notify(':x: PERBot failed to start the reindex job. Check the Render logs.');
  });

  child.on('exit', async (code, signal) => {
    reindexInProgress = false;
    if (code === 0) {
      logger.info('[PERBot] Background reindex finished successfully; reloading.');
      try {
        await loadIndex();
        await notify(':white_check_mark: PERBot finished reindexing and is using the new index.');
      } catch (err) {
        logger.error('Reindex finished but the new index failed to load.', err);
        await notify(':x: Reindex finished but the new index could not be loaded. Check Render logs.');
      }
    } else {
      logger.error(`[PERBot] Background reindex exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      await notify(':x: PERBot reindexing failed. Run `/indexstatus` and check Render logs for details.');
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
        'Usage: `/dt your question here`\nExamples: `/dt how does the PCM box connect to the PDU` · `/dt rev:11 accumulator cooling` · `/dt subsystem:aero layup schedule`',
    });
    return;
  }

  await ack({ response_type: 'ephemeral', text: `PERBot is searching the docs for: ${query}` });

  try {
    const parent = await client.chat.postMessage({
      channel: command.channel_id,
      text: `PERBot search: ${query}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:mag: *PERBot search started*\n*Query:* \`${query}\`` } },
      ],
    });

    const { summary, results, meta } = await answerQuery(query);
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: parent.ts,
      text: `PERBot results for: ${query}`,
      blocks: buildResultBlocks(query, summary, results, meta),
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
      text: `\`/anon\` can only be used in: ${allowedChannels.map((name) => `#${name}`).join(', ')}`,
    });
    return;
  }

  const text = command.text.trim();

  if (!text) {
    await ack({
      response_type: 'ephemeral',
      text: 'Usage: `/anon your message`\nPERBot will post your message in this channel without revealing who sent it.',
    });
    return;
  }

  await ack();

  try {
    await client.chat.postMessage({
      channel: command.channel_id,
      text: `:bust_in_silhouette: Anonymous: ${text}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: ':bust_in_silhouette: Sent anonymously via `/anon`' }] },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });

    await respond({ response_type: 'ephemeral', text: ':white_check_mark: Your anonymous message was posted.' });
  } catch (error) {
    // Log only the error itself — never the sender or message text, so
    // anonymity holds even in server logs.
    logger.error('Anonymous message post failed.', error);
    await respond({
      response_type: 'ephemeral',
      text: ':x: PERBot could not post your anonymous message. If this is a private channel, invite @PERBot to it first and try again.',
    });
  }
});

app.command('/reindex', async ({ ack, command, client }) => {
  await ack({ response_type: 'ephemeral', text: 'PERBot received your reindex request.' });

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
            text: ':arrows_counterclockwise: *PERBot reindex requested*\nStarting a background rebuild of the Notion index.',
          },
        },
      ],
    });

    const started = startBackgroundReindex({ channelId: command.channel_id, threadTs: parent.ts, triggerLabel: '/reindex' });

    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: parent.ts,
      text: started
        ? ':hourglass_flowing_sand: Reindex started. PERBot will post here when it finishes.'
        : ':warning: A PERBot reindex is already in progress.',
    });
  } catch (error) {
    logger.error('Reindex command failed.', error);
    await client.chat.postMessage({ channel: command.channel_id, text: ':x: PERBot could not start the reindex job.' });
  }
});

app.command('/indexstatus', async ({ ack, command, client }) => {
  await ack();
  const status = await loadStatus();
  await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: formatStatus(status) });
});

// ---------------------------------------------------------------------------------------------
// @PERBot mentions: assign → thread → chat → docs
// ---------------------------------------------------------------------------------------------

const userNameCache = new Map<string, string>();

async function displayName(client: any, userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  let name = userId;
  try {
    const res = await client.users.info({ user: userId });
    name = res.user?.real_name || res.user?.profile?.display_name || res.user?.name || userId;
  } catch {
    // fall back to the id
  }
  userNameCache.set(userId, name);
  return name;
}

async function fetchThread(client: any, channel: string, threadTs: string, botUserId?: string): Promise<ThreadMessage[]> {
  const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200 });
  const messages: ThreadMessage[] = [];
  for (const m of res.messages ?? []) {
    if (!m.text) continue;
    if (botUserId && m.user === botUserId) continue;
    const name = m.user ? await displayName(client, m.user) : m.username || 'someone';
    messages.push({ name, text: m.text });
  }
  return messages;
}

const CHAT_REPLIES = [
  "I'm a docs bot — ask me something about the car or the team and I'll dig through Notion. Try `@PERBot how does the PCM talk to the motor controllers?`",
  "Nothing to look up there. Ask me a docs question (`@PERBot what changed in the REV11 accumulator?`) or `@PERBot summarize this thread` inside a thread.",
];

app.event('app_mention', async ({ event, client, context }) => {
  const rawText = 'text' in event ? event.text : '';
  const threadTs = event.thread_ts || event.ts;
  const inThread = Boolean(event.thread_ts);

  // "@PERBot assign @person <task> [by <date>]" — the in-thread way to assign (slash
  // commands can't run in threads). Strip only the bot's own mention so assignee
  // mentions survive.
  const botMention = context.botUserId ? new RegExp(`<@${context.botUserId}(?:\\|[^>]*)?>`, 'g') : null;
  const withoutBot = (botMention ? rawText.replace(botMention, ' ') : rawText).trim();
  if (/^assign\b/i.test(withoutBot)) {
    await assignFromMention(client, {
      text: withoutBot,
      userId: (event as any).user,
      channel: event.channel,
      threadTs,
    });
    return;
  }

  const query = cleanMentionText(rawText);
  const reply = (text: string, blocks?: any[]) =>
    client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text,
      ...(blocks ? { blocks } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });

  if (!query) {
    await reply('Ask me a PER docs question after mentioning me. Example: `@PERBot what changed in REV11 chassis?`');
    return;
  }

  try {
    const intent = await classifyMention(query, inThread);
    logger.info(`Mention intent=${intent} inThread=${inThread} text="${query.slice(0, 80)}"`);

    if (intent === 'chat') {
      await reply(CHAT_REPLIES[Math.floor(Math.random() * CHAT_REPLIES.length)]!);
      return;
    }

    if (intent === 'thread') {
      const messages = await fetchThread(client, event.channel, event.thread_ts!, context.botUserId);
      if (messages.length === 0) {
        await reply("I couldn't read this thread (I may not have history access in this channel).");
        return;
      }
      const summary = await summarizeThread(query, messages);
      await reply(summary, [{ type: 'section', text: { type: 'mrkdwn', text: summary.slice(0, 2900) } }]);
      return;
    }

    const { summary, results, meta } = await answerQuery(query);
    await reply(`PERBot results for: ${query}`, buildResultBlocks(query, summary, results, meta));
  } catch (error) {
    logger.error('Mention handler failed.', error);
    await reply('PERBot hit an error while answering. Check Render logs and try `/indexstatus`.');
  }
});

registerSponsorCommands(app);
registerOpsTaskActions(app);
registerAssignCommand(app);
registerAssignShortcut(app);
registerSponsorActions(app);
registerBenbuysCommand(app);

async function main(): Promise<void> {
  logger.info('[PERBot] Starting Slack Socket Mode...');
  await app.start();
  logger.info('⚡️ PERBot is running in Slack Socket Mode.');
  logger.info(`Index path: ${config.app.indexPath}`);

  const loaded = await ensureIndexLoaded();

  if (!loaded && config.app.autoBootstrapOnMissingIndex) {
    const status = await loadStatus();
    if (status?.state !== 'indexing') {
      startBackgroundReindex({ triggerLabel: 'auto-bootstrap' });
    }
  }

  if (config.app.indexRefreshMinutes > 0) {
    setInterval(() => {
      refreshIndexIfNewer().catch((err) => logger.warn('Index refresh check failed.', err));
    }, config.app.indexRefreshMinutes * 60_000).unref();
  }
}

main().catch((error) => {
  logger.error('Failed to start PERBot.', error);
  process.exitCode = 1;
});
