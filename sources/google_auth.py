"""Service-account auth for Google APIs with no `google-auth` dependency (same stance as the
BenBuys Gmail mailer): sign a JWT with the account's private key, trade it for a one-hour
access token at the OAuth token endpoint, cache until shortly before expiry.
"""
from __future__ import annotations

import base64
import json
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

TOKEN_URI = 'https://oauth2.googleapis.com/token'


@dataclass
class ServiceAccountKey:
    client_email: str
    private_key: str
    token_uri: str | None = None


def _b64url(data: bytes | str) -> str:
    raw = data.encode() if isinstance(data, str) else data
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def parse_service_account_key(raw: str) -> ServiceAccountKey:
    """Accepts the raw key JSON, or the same JSON base64-encoded (easier to paste into a secret)."""
    text = raw if raw.strip().startswith('{') else base64.b64decode(raw.strip()).decode('utf-8')
    key = json.loads(text)
    if not key.get('client_email') or not key.get('private_key'):
        raise ValueError('Service account key is missing client_email or private_key.')
    return ServiceAccountKey(key['client_email'], key['private_key'], key.get('token_uri'))


def load_service_account_key(json_text: str = '', file: str = '') -> ServiceAccountKey | None:
    if json_text:
        return parse_service_account_key(json_text)
    if file:
        with open(file, encoding='utf-8') as f:
            return parse_service_account_key(f.read())
    return None


def build_assertion(key: ServiceAccountKey, scopes: list[str], now_seconds: int | None = None) -> str:
    """The signed JWT assertion Google's token endpoint accepts for a service account."""
    now = int(time.time()) if now_seconds is None else now_seconds
    header = _b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}, separators=(',', ':')))
    claims = _b64url(
        json.dumps(
            {
                'iss': key.client_email,
                'scope': ' '.join(scopes),
                'aud': key.token_uri or TOKEN_URI,
                'iat': now,
                'exp': now + 3600,
            },
            separators=(',', ':'),
        )
    )
    private_key = serialization.load_pem_private_key(key.private_key.encode(), password=None)
    signature = private_key.sign(f'{header}.{claims}'.encode(), padding.PKCS1v15(), hashes.SHA256())  # type: ignore[union-attr,call-arg]
    return f'{header}.{claims}.{_b64url(signature)}'


class ServiceAccountAuth:
    def __init__(self, key: ServiceAccountKey, scopes: list[str], http: httpx.Client | None = None):
        self._key = key
        self._scopes = scopes
        self._http = http or httpx.Client(timeout=15)
        self._token: tuple[str, float] | None = None
        self._lock = threading.Lock()

    @property
    def email(self) -> str:
        return self._key.client_email

    def access_token(self) -> str:
        with self._lock:
            if self._token and self._token[1] - 60 > time.time():
                return self._token[0]
            res = self._http.post(
                self._key.token_uri or TOKEN_URI,
                data={
                    'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                    'assertion': build_assertion(self._key, self._scopes),
                },
            )
            try:
                data: dict[str, Any] = res.json()
            except ValueError:
                data = {}
            if not res.is_success or not data.get('access_token'):
                raise RuntimeError(
                    f"Google service-account token request failed: {res.status_code} {data.get('error', '')} {data.get('error_description', '')}".strip()
                )
            self._token = (data['access_token'], time.time() + float(data.get('expires_in', 3600)))
            return self._token[0]
