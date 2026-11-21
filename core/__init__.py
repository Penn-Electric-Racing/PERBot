"""What every feature shares. Features import from here, never from each other.

  config.py       config: every setting (Config)
  log.py          setup_logging(): logging config for entrypoints
  utils.py        plain helper functions: text, Slack escaping, timestamps, ET and cron slots
  errors.py       PERBotError and its subclasses
  enums.py        Choice / SelectOption: base classes for enums
  abc.py          NotionModel: a row built from a page that keeps its database
  database.py     Database[Model], Properties (readers), *_value() (writers)
  notion.py       Notion: the API client; collect, plain_text, dashed_id, ...
  slack.py        Slack: the client and directory; match_by_name, unwrap_links, ...
  llm.py          LLM: OpenAI and Groq
  job_log.py      JobLog: once-only records in the ⚙️ Job Log
  purchasing.py   the Purchasing (PEFS) database: Col, PurchasingRow, Purchasing
  feature.py      Feature and @command / @event / @shortcut / @task
  ui.py           View, @button, @modal, Interaction
  bolt.py         listener(): calling methods from Bolt
  blocks.py       Block Kit builders (Section, Actions, Button, ...)

The clients are shared: `Notion.shared()`, `Slack.shared()`, `LLM.shared()`, `JobLog.shared()`,
`Purchasing.shared()`. Pass one in explicitly where a test needs a fake. `utils` is imported as a
module (`from core import utils`); types/ holds the raw payload TypedDicts.
"""

from . import utils
from .abc import *
from .blocks import *
from .bolt import *
from .config import *
from .database import *
from .enums import *
from .errors import *
from .feature import *
from .job_log import *
from .llm import *
from .log import *
from .notion import *
from .purchasing import *
from .slack import *
from .ui import *

__all__ = (
    'NotionModel', 'PlainText', 'Markdown', 'Confirm', 'Button', 'Section', 'Actions',
    'Context', 'render', 'listener', 'BOLT_ARGS', 'required', 'require_any', 'optional_number',
    'optional_string', 'optional_list', 'SlackConfig', 'NotionConfig', 'OpenAIConfig',
    'GroqConfig', 'HunterConfig', 'SponsorshipConfig', 'OpsTasksConfig', 'BenbuysMailConfig',
    'BenbuysDigikeyConfig', 'BenbuysConfig', 'RaceConfig', 'PriceCheckConfig', 'ArrivalsConfig',
    'GDriveConfig', 'GitHubConfig', 'AppConfig', 'Config', 'config', 'Properties', 'Database',
    'rich_text_value', 'title_value', 'date_value', 'select_value', 'Choice', 'SelectOption',
    'PERBotError', 'ConfigError', 'NotionError', 'SlackError', 'ScraperError', 'Feature',
    'command', 'event', 'shortcut', 'task', 'JobLog', 'GROQ_BASE_URL', 'LLM', 'setup_logging',
    'API', 'DEFAULT_VERSION', 'MAX_RETRIES', 'NotionAPIError', 'NotionUser', 'collect',
    'plain_text', 'page_id_from', 'dashed_id', 'same_id', 'Notion', 'Col', 'PACK_NOTE_RE',
    'PurchasingRow', 'normalize_part_number', 'Purchasing', 'Indexed', 'normalize_name',
    'name_tokens', 'index_entry', 'index_notion_users', 'match_by_name', 'MessageMarker',
    'ResolvedPeople', 'MENTION_RE', 'EMAIL_RE', 'PLAIN_HANDLE_RE', 'CHANNEL_ID_RE',
    'unwrap_links', 'extract_plain_handles', 'Slack', 'Interaction', 'View', 'button', 'modal',
    'utils',
)
