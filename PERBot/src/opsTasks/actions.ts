import type { App } from '@slack/bolt';
import { logger } from '../utils/logger.js';
import { isoAddDays, nowTimeET, todayIsoET } from '../sponsorship/dates.js';
import { decodeValue, OPS_ACTION_IDS, OPS_ACTION_RE, replaceTaskBlocks, taskBlocks } from './blocks.js';
import { OpsTasksNotion } from './notion.js';

/**
 * Button handlers for the Ops-tasks digest (registered from app.ts; Socket Mode delivers
 * the clicks, so "Interactivity" just has to be switched on in the Slack app config).
 *
 * Each click: ack within 3s → ownership check (value.u === clicker) → RE-READ the task
 * from Notion (the DM may be a week old) → write → rewrite just that task's blocks in the
 * original message via response_url. Idempotent: a second click on an already-Done task
 * reports the state rather than writing again.
 */

const notion = new OpsTasksNotion();

/** Push a week: from the later of today and the current due date, so an overdue task lands next week, not still in the past. */
export function pushedDue(currentDue: string | null, todayIso: string = todayIsoET()): string {
  const base = currentDue && currentDue > todayIso ? currentDue : todayIso;
  return isoAddDays(base, 7);
}

export function registerOpsTaskActions(app: App): void {
  app.action(OPS_ACTION_RE, async ({ ack, body, action, respond }) => {
    await ack();
    const actionId = (action as any)?.action_id as string;
    const value = decodeValue((action as any)?.value);
    const clicker = (body as any)?.user?.id as string | undefined;
    if (!value || !clicker) return;
    if (clicker !== value.u) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: "That task list isn't yours — ask the owner to update it." });
      return;
    }

    try {
      let task = await notion.fetchTask(value.t);
      let note: string;
      let settled = false;

      if (task.status === 'Done') {
        note = `✅ Already Done in Notion`;
        settled = true;
      } else if (actionId === OPS_ACTION_IDS.done) {
        await notion.setStatus(task.id, 'Done');
        task = { ...task, status: 'Done' };
        note = `✅ Done · ${nowTimeET()} via Slack`;
        settled = true;
      } else if (actionId === OPS_ACTION_IDS.progress) {
        await notion.setStatus(task.id, 'In progress');
        task = { ...task, status: 'In progress' };
        note = `🚧 In progress · ${nowTimeET()} via Slack`;
      } else {
        const due = pushedDue(task.due);
        await notion.setDue(task.id, due);
        task = { ...task, due };
        note = `⏭ Pushed to ${due} · ${nowTimeET()} via Slack`;
      }

      const existing: any[] | undefined = (body as any)?.message?.blocks;
      const replacement = taskBlocks(task, value.u, { note, settled });
      if (existing) {
        await respond({ replace_original: true, blocks: replaceTaskBlocks(existing, task.id, replacement), text: `${task.title}: ${note}` });
      } else {
        await respond({ response_type: 'ephemeral', replace_original: false, text: `${task.title}: ${note}` });
      }
      logger.info(`Ops task button: ${clicker} → ${actionId} on "${task.title}".`);
    } catch (err) {
      logger.error(`Ops task button ${actionId} failed`, err);
      await respond({ response_type: 'ephemeral', replace_original: false, text: '✗ Could not update that task in Notion — try again or edit it in Notion.' });
    }
  });
}
