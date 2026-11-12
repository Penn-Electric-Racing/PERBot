"""Pure formatting helpers for Ops tasks — shared by the digest text and its Block Kit version."""
from __future__ import annotations

from sponsorship.dates import days_until
from ops_tasks.notion import OpsTask


def carried_weeks(task: OpsTask) -> int:
    """Whole Saturday meetings that have passed since the task was assigned (0 = fresh)."""
    if not task.week:
        return 0
    age = -days_until(task.week)
    return age // 7 if age > 0 else 0


def is_overdue(task: OpsTask) -> bool:
    return task.due is not None and days_until(task.due) < 0


def _short_date(iso: str) -> str:
    """"9/19" — matches how the meeting pages are named."""
    _, m, d = iso.split('-')[:3]
    return f'{int(m)}/{int(d[:2])}'


def sort_tasks(tasks: list[OpsTask]) -> list[OpsTask]:
    """Overdue first (oldest due first), then by due date, undated last."""
    return sorted(tasks, key=lambda t: (0 if is_overdue(t) else 1, t.due or '9999'))


def task_line(task: OpsTask) -> str:
    link = f'<{task.url}|{task.title}>'
    parts: list[str] = []
    if task.due:
        parts.append(f"due {_short_date(task.due)}{' 🔴 overdue' if is_overdue(task) else ''}")
    else:
        parts.append('no due date')
    carried = carried_weeks(task)
    if carried >= 1:
        parts.append(f"carried {carried} wk{'' if carried == 1 else 's'}")
    return f"• {link} — {' · '.join(parts)}"
