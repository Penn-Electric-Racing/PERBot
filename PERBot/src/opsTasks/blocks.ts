import { config } from '../config.js';
import { OpsTask } from './notion.js';
import { isOverdue, sortTasks, taskLine } from './format.js';

/**
 * Block Kit for the Ops-tasks digest DM: one section per task followed by a row of
 * buttons (Done / In progress / Push a week). Clicks are handled by actions.ts in the
 * Bolt app (Socket Mode), which writes to Notion and rewrites the DM in place — Slack is
 * a second way to update, Notion stays the system of record.
 *
 * Button values carry the task id AND the Slack user the DM was sent to, so a click is
 * honoured only from that user (cheap ownership check that needs no directory lookup).
 */

export const OPS_ACTION_IDS = {
  done: 'ops_task_done',
  progress: 'ops_task_progress',
  push: 'ops_task_push',
} as const;
export const OPS_ACTION_RE = /^ops_task_(done|progress|push)$/;

export interface OpsButtonValue {
  /** Notion page id of the task. */
  t: string;
  /** Slack user id the buttons were rendered for. */
  u: string;
}

export function encodeValue(v: OpsButtonValue): string {
  return JSON.stringify(v);
}
export function decodeValue(raw: string | undefined): OpsButtonValue | null {
  try {
    const v = JSON.parse(raw ?? '');
    return typeof v?.t === 'string' && typeof v?.u === 'string' ? { t: v.t, u: v.u } : null;
  } catch {
    return null;
  }
}

export const sectionBlockId = (taskId: string) => `ops_task:${taskId}`;
export const actionsBlockId = (taskId: string) => `ops_task_actions:${taskId}`;

function button(text: string, actionId: string, value: OpsButtonValue, style?: 'primary' | 'danger') {
  return {
    type: 'button',
    text: { type: 'plain_text', text, emoji: true },
    action_id: actionId,
    value: encodeValue(value),
    ...(style ? { style } : {}),
  };
}

/**
 * The two blocks for one task. `note` (e.g. "✅ Done · 1:42 PM") is appended to the line
 * after a Slack update; `settled` drops the buttons (task is Done).
 */
export function taskBlocks(task: OpsTask, slackUserId: string, opts: { note?: string; settled?: boolean } = {}): any[] {
  const value: OpsButtonValue = { t: task.id, u: slackUserId };
  const line = opts.settled ? `~${taskLine(task).replace(/^• /, '')}~` : taskLine(task).replace(/^• /, '');
  const text = opts.note ? `${line}\n${opts.note}` : line;
  const blocks: any[] = [{ type: 'section', block_id: sectionBlockId(task.id), text: { type: 'mrkdwn', text } }];
  if (!opts.settled) {
    const elements = [button('✅ Done', OPS_ACTION_IDS.done, value, 'primary')];
    if (task.status !== 'In progress') elements.push(button('🚧 In progress', OPS_ACTION_IDS.progress, value));
    elements.push(button('⏭ Push a week', OPS_ACTION_IDS.push, value));
    blocks.push({ type: 'actions', block_id: actionsBlockId(task.id), elements });
  }
  return blocks;
}

/** Full digest as blocks (header + tasks + footer). Pair with buildDigest() text as the fallback. */
export function buildDigestBlocks(tasks: OpsTask[], slackUserId: string): any[] {
  const sorted = sortTasks(tasks);
  const overdue = sorted.filter(isOverdue).length;
  const header = `:clipboard: *Your open Ops tasks (${sorted.length}${overdue > 0 ? `, ${overdue} overdue` : ''})*`;
  const footer = `_Update here with the buttons or in Notion — Saturday's walkthrough runs off this list. <${config.opsTasks.myOpenViewUrl}|My open>_`;
  return [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    ...sorted.flatMap((t) => taskBlocks(t, slackUserId)),
    { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] },
  ];
}

/** Replace one task's blocks inside an existing message (by block_id). Returns a new array. */
export function replaceTaskBlocks(blocks: any[], taskId: string, replacement: any[]): any[] {
  const out: any[] = [];
  let inserted = false;
  for (const b of blocks) {
    if (b?.block_id === sectionBlockId(taskId)) {
      if (!inserted) {
        out.push(...replacement);
        inserted = true;
      }
      continue;
    }
    if (b?.block_id === actionsBlockId(taskId)) continue;
    out.push(b);
  }
  return inserted ? out : [...blocks, ...replacement];
}

/** The DM an assignee gets from `/assign`: who assigned it + the task with its buttons. */
export function assignmentDmBlocks(task: OpsTask, assignerSlackId: string, assigneeSlackId: string): any[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `:pushpin: <@${assignerSlackId}> assigned you a task:` } },
    ...taskBlocks(task, assigneeSlackId),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `_It's in the Ops Tasks list — Sunday's digest will include it. <${config.opsTasks.myOpenViewUrl}|My open>_` }] },
  ];
}
