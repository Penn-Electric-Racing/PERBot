"""Tests run without a .env: give `perbot.config` the two variables it requires at import."""
import os

os.environ.setdefault('SLACK_BOT_TOKEN', 'xoxb-test')
os.environ.setdefault('NOTION_TOKEN', 'secret_test')
