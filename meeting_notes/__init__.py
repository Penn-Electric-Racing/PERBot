"""Meeting notes: post the kickoff thread for subsystem updates, then turn the replies into the
meeting's Notion page. Both run from GitHub Actions.

  parse_updates.py    parse a subsystem update thread
  notion_writer.py    create the meeting's Notion page
  slack_helpers.py    the Slack calls the jobs make
  time_check.py       the late-tolerant cron gate
  config.py           settings

Run with `python -m`:

  post_kickoff.py     `python -m meeting_notes.post_kickoff`
  generate_notes.py   `python -m meeting_notes.generate_notes`
"""

from .config import *
from .notion_writer import *
from .parse_updates import *
from .slack_helpers import *
from .time_check import *

__all__ = (
    'Subsystem', 'SUBSYSTEMS', 'NOTION_PARENT_PAGE_ID', 'SLACK_WORKSPACE_SUBDOMAIN',
    'KICKOFF_MESSAGE', 'KICKOFF_SIGNATURE', 'SubsystemContent', 'create_meeting_notes_page',
    'find_existing_meeting_page_for_today', 'GROQ_API_URL', 'GROQ_MODEL', 'SECTION_KEYS',
    'ParsedUpdate', 'EMPTY_UPDATE', 'ProcessedMessage', 'HEADER_MAP', 'detect_header',
    'parse_subsystem_updates', 'get_channel_id', 'post_kickoff_message',
    'find_most_recent_bot_thread', 'get_thread_replies', 'get_message_permalink',
    'get_user_display_name', 'assert_expected_et_hour_range', 'assert_expected_et_hour',
)
