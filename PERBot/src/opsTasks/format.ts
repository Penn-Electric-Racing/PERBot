import { daysUntil } from '../sponsorship/dates.js';
import { OpsTask } from './notion.js';

/** Pure formatting helpers for Ops tasks — shared by the digest text and its Block Kit version. */

/** Whole Saturday meetings that have passed since the task was assigned (0 = fresh). */
export function carriedWeeks(task: OpsTask): number {
  if (!task.week) return 0;
  const age = -daysUntil(task.week);
  return age > 0 ? Math.floor(age / 7) : 0;
}

export function isOverdue(task: OpsTask): boolean {
  return task.due !== null && daysUntil(task.due) < 0;
}

/** "9/19" — matches how the meeting pages are named. */
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** Overdue first (oldest due first), then by due date, undated last. */
export function sortTasks(tasks: OpsTask[]): OpsTask[] {
  return [...tasks].sort((a, b) => {
    const ao = isOverdue(a) ? 0 : 1;
    const bo = isOverdue(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return (a.due ?? '9999').localeCompare(b.due ?? '9999');
  });
}

export function taskLine(task: OpsTask): string {
  const link = `<${task.url}|${task.title}>`;
  const parts: string[] = [];
  if (task.due) parts.push(`due ${shortDate(task.due)}${isOverdue(task) ? ' 🔴 overdue' : ''}`);
  else parts.push('no due date');
  const carried = carriedWeeks(task);
  if (carried >= 1) parts.push(`carried ${carried} wk${carried === 1 ? '' : 's'}`);
  return `• ${link} — ${parts.join(' · ')}`;
}

