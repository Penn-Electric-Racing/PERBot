"""Every exception PERBot raises on purpose, in one tree, so callers can catch as broadly or as
narrowly as they need (`except PERBotError` catches all of them).

    PERBotError
    ├── ConfigError       a required setting is missing or invalid
    ├── NotionError       Notion refused a request (NotionAPIError carries the HTTP status)
    ├── SlackError        a Slack call failed in a way the caller should hear about
    └── ScraperError      part search (price_check.scrapers) could not get an answer
"""
from __future__ import annotations

__all__ = ['PERBotError', 'ConfigError', 'NotionError', 'SlackError', 'ScraperError']


class PERBotError(Exception):
    """Base class of every PERBot exception."""


class ConfigError(PERBotError):
    """A required setting is missing or invalid."""


class NotionError(PERBotError):
    """A Notion request failed. See `core.notion.NotionAPIError` for HTTP failures."""


class SlackError(PERBotError):
    """A Slack call failed in a way the caller should hear about."""


class ScraperError(PERBotError):
    """Part search could not get an answer (a search backend, a distributor API or the LLM)."""
