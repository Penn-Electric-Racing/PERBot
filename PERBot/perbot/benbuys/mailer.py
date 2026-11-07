"""Email transport for `/benbuys done`. Pluggable so the sender can change without touching the
command:
  • gmail   — Gmail API `users.messages.send` on the electric@ mailbox via an OAuth2 refresh
              token (no Google SDK; plain HTTP). The default.
  • webhook — POST the JSON email to an HTTP endpoint (e.g. a Power Automate "When an HTTP request
              is received" flow with a Gmail "Send email" action).
`create_mailer()` returns None when nothing is configured; `done` then refuses unless `--no-send`
is given, so a half-configured deploy can never mark rows ordered silently.
"""
from __future__ import annotations

import base64
import re
from typing import Any, Protocol

import httpx

from ..config import config
from ..utils.logger import logger
from .email import RequisitionEmail


class Mailer(Protocol):
    name: str

    def send(self, email: RequisitionEmail) -> str:
        """Sends the email; returns the transport's message id ('' when it has none)."""
        ...


def _b64url(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode('utf-8')).decode().rstrip('=')


def to_rfc822(email: RequisitionEmail) -> str:
    """RFC 5322 text/plain message. Header values are ASCII here (addresses, bracket tags, digits)."""
    headers = [
        f'From: {email.from_addr}',
        f"To: {', '.join(email.to)}",
        f"Cc: {', '.join(email.cc)}" if email.cc else '',
        f'Subject: {email.subject}',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
    ]
    body = re.sub(r'\r?\n', '\r\n', email.body)
    return '\r\n'.join(h for h in headers if h) + '\r\n\r\n' + body


def _json(res: httpx.Response) -> Any:
    try:
        return res.json()
    except ValueError:
        return {}


class GmailApiMailer:
    name = 'gmail'

    def __init__(self, client_id: str, client_secret: str, refresh_token: str, http: httpx.Client | None = None):
        self._creds = {'client_id': client_id, 'client_secret': client_secret, 'refresh_token': refresh_token}
        self._http = http or httpx.Client(timeout=20)

    def _access_token(self) -> str:
        res = self._http.post(
            'https://oauth2.googleapis.com/token',
            data={**self._creds, 'grant_type': 'refresh_token'},
            timeout=15,
        )
        data = _json(res)
        if not res.is_success or not data.get('access_token'):
            raise RuntimeError(
                f"Gmail OAuth token refresh failed: {res.status_code} {data.get('error', '')} {data.get('error_description', '')}".strip()
            )
        return data['access_token']

    def send(self, email: RequisitionEmail) -> str:
        token = self._access_token()
        res = self._http.post(
            'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
            json={'raw': _b64url(to_rfc822(email))},
        )
        data = _json(res)
        if not res.is_success:
            raise RuntimeError(f"Gmail send failed: {res.status_code} {(data.get('error') or {}).get('message', '')}".strip())
        logger.info(f"BenBuys email sent via Gmail (id {data.get('id')}): {email.subject}")
        return str(data.get('id') or '')


class WebhookMailer:
    name = 'webhook'

    def __init__(self, url: str, http: httpx.Client | None = None):
        self._url = url
        self._http = http or httpx.Client(timeout=20)

    def send(self, email: RequisitionEmail) -> str:
        res = self._http.post(
            self._url,
            json={
                'from': email.from_addr,
                'to': ';'.join(email.to),
                'cc': ';'.join(email.cc),
                'subject': email.subject,
                'body': email.body,
            },
        )
        if not res.is_success:
            raise RuntimeError(f'Email webhook failed: {res.status_code} {res.text[:200]}')
        logger.info(f'BenBuys email sent via webhook: {email.subject}')
        return res.headers.get('x-ms-workflow-run-id') or ''


def create_mailer() -> Mailer | None:
    """Pick the transport from config; None when none is configured."""
    m = config.benbuys.mail
    if m.transport == 'gmail' and m.gmail_client_id and m.gmail_client_secret and m.gmail_refresh_token:
        return GmailApiMailer(m.gmail_client_id, m.gmail_client_secret, m.gmail_refresh_token)
    if m.transport == 'webhook' and m.webhook_url:
        return WebhookMailer(m.webhook_url)
    return None
