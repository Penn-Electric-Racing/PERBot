"""Meeting Notes feature — configuration

Edit this file to add/remove subsystems, change the parent Notion page, customize the kickoff
message, or change the Slack workspace.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Subsystem:
    # Display name in the Notion meeting notes page (must match section headings)
    name: str
    # Slack channel name without the `#`
    slack_channel: str


SUBSYSTEMS = [
    Subsystem('Accumulator', 'accumulator'),
    Subsystem('Drivetrain', 'drivetrain'),
    Subsystem('Suspension ඞ', 'suspension'),
    Subsystem('Driver Interface', 'driver_interface'),
    Subsystem('Aerodynamics', 'aero_composites'),
    Subsystem('Vehicle Dynamics', 'vehicledynamics'),
]

# Parent Notion page where new "MM/DD Mechanical Meeting" pages are created under
NOTION_PARENT_PAGE_ID = '33b560bcc03980599c0cd06080df6d5a'  # "REV12 Mechanical Meeting Notes"

# Used to build clickable Slack permalinks in the Notion page. Replace if PER's workspace subdomain differs.
SLACK_WORKSPACE_SUBDOMAIN = 'pennelectricracing'

# Posted by PERBot in each subsystem channel Monday 9am ET. `{date}` is replaced at runtime.
KICKOFF_MESSAGE = """📋 *Weekly Update Thread! Week of {date}*

Reply in this thread with what you've been working on.

*Option 1: Use section headers* (recognized headers: Complete, Incomplete, Deadlines, Logistical, Design, Manufacturing, Overdue, Look-ahead)
*Option 2: Write naturally!*

📷 Screenshots encouraged — they'll link back to this thread from the Notion notes.
🕛 *Snapshot Wednesday 12:00 PM ET, so please thread before then!*"""

# Signature used by `find_most_recent_bot_thread` to identify the kickoff message. Must appear in KICKOFF_MESSAGE.
KICKOFF_SIGNATURE = 'Weekly Update Thread'
