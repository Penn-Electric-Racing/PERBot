"""Tests run without a .env: give `config` the two variables it requires at import."""
import os

os.environ.setdefault('SLACK_BOT_TOKEN', 'xoxb-test')
os.environ.setdefault('NOTION_TOKEN', 'secret_test')

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """A test that reaches real HTTP fails instead of calling out (fake `http.get`/`request=` instead)."""
    from core import http

    def refuse():
        raise AssertionError('test tried to open a real HTTP session; fake http.request instead')

    monkeypatch.setattr(http, 'session', refuse)
