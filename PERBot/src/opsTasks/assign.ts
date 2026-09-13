import type { App, RespondFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { logger } from '../utils/logger.js';
import { isoAddDays, todayIsoET } from '../sponsorship/dates.js';
import { extractPlainHandles, MENTION_RE, resolveAssignees, unwrapSlackLinks } from '../sponsorship/slack.js';
import { assignmentDmBlocks } from './blocks.js';
import { taskLine } from './format.js';
import { OpsTask, OpsTasksNotion } from './notion.js';

/**
 * `/assign @person <task> [by <date>]` — put a task on someone's Ops list from Slack
 * (Arjun, 2026-09-13). Anyone can assign. Creates an Ops Tasks row (Status Not started,
 * Due = the date given, else NEXT SATURDAY — the meeting convention), then:
 *   • posts PUBLICLY in the channel the command was run in ("📌 @A assigned @B: …"), and
 *   • DMs each assignee the task with the Done / In progress / Push buttons.
 * If the person or the task text is missing, PERBot opens a small form (person picker,
 * task, date) pre-filled with whatever it could parse; plain `/assign` opens it empty.
 * Mentions arrive as real `<@U…>` only if the command has link-escaping on; typed
 * `@handles` are resolved via the Slack directory (same as /sponsor). `me` = yourself.
 *
 * THREADS: Slack doesn't allow custom slash commands inside threads (platform rule), so
 * two thread-friendly entry points share the same code path:
 *   • a MESSAGE SHORTCUT ("Assign as Ops task" in a message's ··· menu, threads included)
 *     that opens the form pre-filled with that message's text and author; and
 *   • `@PERBot assign @person <task> [by <date>]` typed in the thread (app_mention).
 * Both post the public confirmation as a reply IN that thread.
 */

const ASSIGN_MODAL_ID = 'ops_assign_modal';
const notion = new OpsTasksNotion();

export interface ParsedAssign {
  /** Real Slack mentions. */
  slackIds: string[];
  /** Typed @handles (not real mentions) — resolved via the directory. */
  handles: string[];
  /** `me` was used. */
  self: boolean;
  task: string;
  /** YYYY-MM-DD parsed from a trailing "by <date>" / "due <date>", or null. */
  dueIso: string | null;
  /** The raw date phrase when one was given but not understood. */
  badDate: string | null;
}

/** Next Saturday (ET) — the default Due; on a Saturday it's the following one. */
export function nextSaturdayIso(todayIso: string = todayIsoET()): string {
  const dow = new Date(`${todayIso}T12:00:00Z`).getUTCDay();
  const days = (6 - dow + 7) % 7 || 7;
  return isoAddDays(todayIso, days);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "friday" · "next sat" · "tomorrow" · "9/20" · "2026-09-20" → YYYY-MM-DD (null if not understood). */
export function parseDueDate(phrase: string, todayIso: string = todayIsoET()): string | null {
  const t = phrase.trim().toLowerCase().replace(/^(next|this)\s+/, '').replace(/\.$/, '');
  if (!t) return null;
  if (t === 'today') return todayIso;
  if (t === 'tomorrow') return isoAddDays(todayIso, 1);
  if (t === 'eow' || t === 'end of week') return nextSaturdayIso(todayIso);
  const wd = WEEKDAYS.findIndex((w) => w === t || w.slice(0, 3) === t);
  if (wd >= 0) {
    const dow = new Date(`${todayIso}T12:00:00Z`).getUTCDay();
    return isoAddDays(todayIso, (wd - dow + 7) % 7 || 7);
  }
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return t;
  m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(todayIso.slice(0, 4));
    const iso = `${year}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    if (Number.isNaN(Date.parse(iso))) return null;
    // A month/day already past this year means next year (e.g. "1/10" typed in December).
    return !m[3] && iso < todayIso ? isoAddDays(`${year + 1}${iso.slice(4)}`, 0) : iso;
  }
  return null;
}

export function parseAssign(raw: string, todayIso: string = todayIsoET()): ParsedAssign {
  let text = unwrapSlackLinks(raw).trim();
  const slackIds = [...text.matchAll(MENTION_RE)].map((m) => m[1]!);
  text = text.replace(MENTION_RE, ' ');
  const { handles, cleaned } = extractPlainHandles(text);
  text = cleaned;
  let self = false;
  if (/^me\b/i.test(text)) {
    self = true;
    text = text.replace(/^me\b[:,]?\s*/i, '');
  }
  let dueIso: string | null = null;
  let badDate: string | null = null;
  const by = text.match(/\s+(?:by|due)\s+([^,]+?)\s*$/i);
  if (by) {
    const parsed = parseDueDate(by[1]!, todayIso);
    if (parsed) {
      dueIso = parsed;
      text = text.slice(0, by.index).trim();
    } else {
      badDate = by[1]!.trim();
    }
  }
  const task = text.replace(/^[:\-–—]\s*/, '').replace(/[\s,;:\-–—]+$/, '').replace(/\s+/g, ' ').trim();
  return { slackIds, handles, self, task, dueIso, badDate };
}

function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
}

/** Create the task, post publicly, DM each assignee. Returns the public line. */
async function createAndAnnounce(
  client: WebClient,
  opts: { assignerSlackId: string; assigneeSlackIds: string[]; ownerNotionIds: string[]; task: string; dueIso: string | null }
): Promise<{ task: OpsTask; publicText: string }> {
  const task = await notion.createTask({ title: opts.task, ownerIds: opts.ownerNotionIds, dueIso: opts.dueIso });
  const who = opts.assigneeSlackIds.map((id) => `<@${id}>`).join(', ');
  const publicText = `:pushpin: <@${opts.assignerSlackId}> assigned ${who}: *${task.title}*${task.due ? ` · due ${shortDate(task.due)}` : ''} · <${task.url}|Open in Notion>`;
  for (const assignee of opts.assigneeSlackIds) {
    try {
      await client.chat.postMessage({
        channel: assignee,
        text: `<@${opts.assignerSlackId}> assigned you: ${taskLine(task)}`,
        blocks: assignmentDmBlocks(task, opts.assignerSlackId, assignee),
        unfurl_links: false,
      });
    } catch (err) {
      logger.error(`/assign: DM to ${assignee} failed`, err);
    }
  }
  return { task, publicText };
}

/** Resolve Slack mentions/handles → Notion owners; returns Slack ids alongside for the DMs. */
async function resolveOwners(client: WebClient, slackIds: string[], handles: string[]) {
  const { notionIds, labels, unresolved } = await resolveAssignees(client, slackIds, handles);
  // labels are `<@U…>` for every resolved person, in the same order as notionIds.
  const resolvedSlackIds = labels.map((l) => l.replace(/^<@|>$/g, ''));
  return { notionIds, resolvedSlackIds, unresolved };
}

export const ASSIGN_SHORTCUT_ID = 'ops_assign_shortcut';

interface AssignMeta {
  ch: string; // channel to post the public line in
  a: string; // assigner Slack id
  ts?: string; // thread to reply in (message shortcut / mention paths)
}

function assignModal(meta: AssignMeta, prefill: { users: string[]; task: string; dueIso: string | null }) {
  return {
    type: 'modal' as const,
    callback_id: ASSIGN_MODAL_ID,
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text' as const, text: 'Assign an Ops task' },
    submit: { type: 'plain_text' as const, text: 'Assign' },
    close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'owners',
        label: { type: 'plain_text', text: 'Who' },
        element: { type: 'multi_users_select', action_id: 'owners', placeholder: { type: 'plain_text', text: 'Pick one or more people' }, ...(prefill.users.length ? { initial_users: prefill.users } : {}) },
      },
      {
        type: 'input',
        block_id: 'task',
        label: { type: 'plain_text', text: 'Task' },
        element: { type: 'plain_text_input', action_id: 'task', max_length: 200, placeholder: { type: 'plain_text', text: 'Email Toray about the carbon sponsorship' }, ...(prefill.task ? { initial_value: prefill.task } : {}) },
      },
      {
        type: 'input',
        block_id: 'due',
        optional: true,
        label: { type: 'plain_text', text: 'Due' },
        hint: { type: 'plain_text', text: 'Defaults to next Saturday (the meeting).' },
        element: { type: 'datepicker', action_id: 'due', initial_date: prefill.dueIso ?? nextSaturdayIso() },
      },
    ],
  };
}

const USAGE =
  'Usage: `/assign @person <task> [by <date>]` — e.g. `/assign @koseli Email Toray about carbon by Friday`. ' +
  'Several people are fine; `me` works too. No date → due next Saturday. Plain `/assign` opens a form.';

export function registerAssignCommand(app: App): void {
  app.command('/assign', async ({ ack, command, respond, client }) => {
    const parsed = parseAssign(command.text);
    const wantsForm = !parsed.task || (parsed.slackIds.length === 0 && parsed.handles.length === 0 && !parsed.self);
    if (wantsForm) {
      // Open the form immediately (trigger_id is only good for 3s) — no Notion calls first.
      await ack();
      try {
        await client.views.open({
          trigger_id: command.trigger_id,
          view: assignModal({ ch: command.channel_id, a: command.user_id }, { users: parsed.self ? [command.user_id] : parsed.slackIds, task: parsed.task, dueIso: parsed.dueIso }),
        });
      } catch (err) {
        logger.error('/assign: could not open form', err);
        await respond({ response_type: 'ephemeral', text: USAGE });
      }
      return;
    }

    await ack();
    try {
      const slackIds = parsed.self ? [...new Set([command.user_id, ...parsed.slackIds])] : parsed.slackIds;
      const { notionIds, resolvedSlackIds, unresolved } = await resolveOwners(client as WebClient, slackIds, parsed.handles);
      if (notionIds.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: `I couldn't match ${unresolved.join(', ') || 'that person'} to a Notion account. Pick them from the @ popup so it turns into a blue chip, or run plain \`/assign\` for the form.`,
        });
        return;
      }
      const { publicText } = await createAndAnnounce(client as WebClient, {
        assignerSlackId: command.user_id,
        assigneeSlackIds: resolvedSlackIds,
        ownerNotionIds: notionIds,
        task: parsed.task,
        dueIso: parsed.dueIso ?? nextSaturdayIso(),
      });
      await respond({ response_type: 'in_channel', text: publicText });
      const warnings: string[] = [];
      if (unresolved.length) warnings.push(`Couldn't match ${unresolved.join(', ')} — not added.`);
      if (parsed.badDate) warnings.push(`Didn't understand the date "${parsed.badDate}" — used next Saturday. Try "by Friday" or "by 9/20".`);
      if (warnings.length) await respond({ response_type: 'ephemeral', text: warnings.join(' ') });
    } catch (err) {
      logger.error('/assign failed', err);
      await respond({ response_type: 'ephemeral', text: '✗ Something went wrong creating that task. Check the PERBot logs.' });
    }
  });

  app.view(ASSIGN_MODAL_ID, async ({ ack, body, view, client }) => {
    const values: any = view.state.values;
    const users: string[] = values?.owners?.owners?.selected_users ?? [];
    const task = String(values?.task?.task?.value ?? '').trim();
    const dueIso: string | null = values?.due?.due?.selected_date ?? null;
    if (users.length === 0 || !task) {
      await ack({ response_action: 'errors', errors: { ...(users.length ? {} : { owners: 'Pick at least one person.' }), ...(task ? {} : { task: 'What needs doing?' }) } });
      return;
    }
    await ack();
    const meta = JSON.parse(view.private_metadata || '{}') as AssignMeta;
    const assigner = (body as any)?.user?.id ?? meta.a;
    try {
      const { notionIds, resolvedSlackIds, unresolved } = await resolveOwners(client as WebClient, users, []);
      if (notionIds.length === 0) {
        await client.chat.postMessage({ channel: assigner, text: `I couldn't match ${unresolved.join(', ')} to a Notion account, so nothing was assigned.` });
        return;
      }
      const { publicText } = await createAndAnnounce(client as WebClient, {
        assignerSlackId: assigner,
        assigneeSlackIds: resolvedSlackIds,
        ownerNotionIds: notionIds,
        task,
        dueIso: dueIso ?? nextSaturdayIso(),
      });
      // Public post in the channel the command was run in; if the bot can't post there
      // (a private channel it isn't in), tell the assigner privately instead.
      try {
        await client.chat.postMessage({ channel: meta.ch, ...(meta.ts ? { thread_ts: meta.ts } : {}), text: publicText, unfurl_links: false });
      } catch {
        await client.chat.postMessage({ channel: assigner, text: `${publicText}\n_(couldn't post in that channel — invite PERBot to it)_`, unfurl_links: false });
      }
      if (unresolved.length) await client.chat.postMessage({ channel: assigner, text: `Couldn't match ${unresolved.join(', ')} to Notion — not added.` });
    } catch (err) {
      logger.error('/assign form failed', err);
      await client.chat.postMessage({ channel: assigner, text: '✗ Something went wrong creating that task. Check the PERBot logs.' });
    }
  });
}

/** Message text → a sensible task title (mentions/links unwrapped, whitespace collapsed, capped). */
function taskFromMessage(text: string): string {
  return unwrapSlackLinks(text)
    .replace(MENTION_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** "Assign as Ops task" message shortcut — works from any message, including thread replies. */
export function registerAssignShortcut(app: App): void {
  app.shortcut({ callback_id: ASSIGN_SHORTCUT_ID, type: 'message_action' }, async ({ ack, shortcut, client }) => {
    await ack();
    const sc: any = shortcut;
    const msg = sc.message ?? {};
    const channel: string = sc.channel?.id ?? '';
    const threadTs: string | undefined = msg.thread_ts ?? msg.ts;
    // Pre-fill "who" with the message's author when it's a person (not a bot post) — the
    // usual case is "assign this to the person who raised it"; easy to change in the form.
    const author: string | undefined = typeof msg.user === 'string' && !msg.bot_id ? msg.user : undefined;
    try {
      await client.views.open({
        trigger_id: sc.trigger_id,
        view: assignModal(
          { ch: channel, a: sc.user?.id ?? '', ts: threadTs },
          { users: author ? [author] : [], task: taskFromMessage(String(msg.text ?? '')), dueIso: null }
        ),
      });
    } catch (err) {
      logger.error('Assign shortcut: could not open form', err);
    }
  });
}

/**
 * `@PERBot assign @person <task> [by <date>]` — the in-thread text path (app_mention).
 * `text` must already have the bot's own mention removed but OTHER mentions intact.
 * There's no trigger_id on an event, so missing info gets a usage reply in the thread
 * instead of the form.
 */
export async function assignFromMention(
  client: WebClient,
  opts: { text: string; userId: string; channel: string; threadTs?: string }
): Promise<void> {
  const body = opts.text.replace(/^\s*assign\b[:,]?\s*/i, '');
  const parsed = parseAssign(body);
  const reply = (text: string) =>
    client.chat.postMessage({ channel: opts.channel, ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}), text, unfurl_links: false });

  if (!parsed.task || (parsed.slackIds.length === 0 && parsed.handles.length === 0 && !parsed.self)) {
    await reply(`<@${opts.userId}> ${USAGE.replace('Usage: `/assign', 'Usage: `@PERBot assign').replace(' Plain `/assign` opens a form.', ' (Slash commands don’t work in threads — the ··· menu → *Assign as Ops task* opens the form.)')}`);
    return;
  }
  try {
    const slackIds = parsed.self ? [...new Set([opts.userId, ...parsed.slackIds])] : parsed.slackIds;
    const { notionIds, resolvedSlackIds, unresolved } = await resolveOwners(client, slackIds, parsed.handles);
    if (notionIds.length === 0) {
      await reply(`<@${opts.userId}> I couldn't match ${unresolved.join(', ') || 'that person'} to a Notion account — nothing assigned.`);
      return;
    }
    const { publicText } = await createAndAnnounce(client, {
      assignerSlackId: opts.userId,
      assigneeSlackIds: resolvedSlackIds,
      ownerNotionIds: notionIds,
      task: parsed.task,
      dueIso: parsed.dueIso ?? nextSaturdayIso(),
    });
    const notes: string[] = [];
    if (unresolved.length) notes.push(`(couldn't match ${unresolved.join(', ')} — not added)`);
    if (parsed.badDate) notes.push(`(didn't understand "${parsed.badDate}" — used next Saturday)`);
    await reply(notes.length ? `${publicText}\n_${notes.join(' ')}_` : publicText);
  } catch (err) {
    logger.error('assign-from-mention failed', err);
    await reply(`<@${opts.userId}> ✗ Something went wrong creating that task. Check the PERBot logs.`);
  }
}
