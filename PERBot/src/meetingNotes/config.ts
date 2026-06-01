/**
 * Meeting Notes feature — configuration
 *
 * Edit this file to add/remove subsystems, change the parent Notion page,
 * customize the kickoff message, or change the Slack workspace.
 */

export interface Subsystem {
  /** Display name in the Notion meeting notes page (must match section headings) */
  name: string;
  /** Slack channel name without the `#` */
  slackChannel: string;
}

export const SUBSYSTEMS: Subsystem[] = [
  { name: 'Accumulator', slackChannel: 'accumulator' },
  { name: 'Drivetrain', slackChannel: 'drivetrain' },
  { name: 'Suspension ඞ', slackChannel: 'suspension' },
  { name: 'Driver Interface', slackChannel: 'chassis' },
  { name: 'Aerodynamics', slackChannel: 'aero_composites' },
  { name: 'Vehicle Dynamics', slackChannel: 'vehicledynamics' },
];

/** Parent Notion page where new "MM/DD Mechanical Meeting" pages are created under */
export const NOTION_PARENT_PAGE_ID = '33b560bcc03980599c0cd06080df6d5a'; // "REV12 Mechanical Meeting Notes"

/** Used to build clickable Slack permalinks in the Notion page. Replace if PER's workspace subdomain differs. */
export const SLACK_WORKSPACE_SUBDOMAIN = 'pennelectricracing';

/** Posted by PERBot in each subsystem channel Monday 9am ET. `{date}` is replaced at runtime. */
export const KICKOFF_MESSAGE = `📋 *Weekly Update Thread! Week of {date}*

Reply in this thread with what you've been working on. Two ways:

*Option 1 — Use section headers* (more precise placement in meeting notes):
\`\`\`
*Complete:*
*Design:*
*Manufacturing:*
*Deadlines:*
\`\`\`
Recognized headers: Complete, Incomplete, Deadlines, Logistical, Design, Manufacturing, Overdue, Look-ahead

*Option 2 — Just write naturally.* AI will sort what you wrote into the right sections.

📷 Screenshots are encouraged — attach them to whichever message they belong to. They'll link back to this thread from the Notion notes.

🕛 *Snapshot Wednesday 12:00 PM ET, so please thread before then!*`;

/** Signature used by `findMostRecentBotThread` to identify the kickoff message. Must appear in KICKOFF_MESSAGE. */
export const KICKOFF_SIGNATURE = 'Weekly Update Thread';
