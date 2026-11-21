"""The bot's language models, for every feature: `LLM.shared()`.

  OpenAI (OPENAI_API_KEY)  written answers, photo reading, structured output: `respond`, `.openai`
  Groq   (GROQ_API_KEY)    fast bounded tasks (classify, rerank, enrich): `groq_chat`, `groq_json`

Groq exposes an OpenAI-compatible endpoint, so both are the OpenAI SDK's AsyncOpenAI, on aiohttp
(`DefaultAioHttpClient`). The clients are built on first use, so a feature that never calls a
model never needs its key, and once per event loop, since an aiohttp session can't cross loops.
"""
from __future__ import annotations

import asyncio
import weakref
from typing import Any, ClassVar

from openai import AsyncOpenAI, DefaultAioHttpClient

from core.config import config

__all__ = ['GROQ_BASE_URL', 'LLM']

GROQ_BASE_URL = 'https://api.groq.com/openai/v1'


class LLM:
    _shared: ClassVar['LLM | None'] = None

    @classmethod
    def shared(cls) -> 'LLM':
        if cls._shared is None:
            cls._shared = cls()
        return cls._shared

    def __init__(self) -> None:
        # (event loop, provider) -> client
        self._clients: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, AsyncOpenAI]] = weakref.WeakKeyDictionary()

    def _client(self, provider: str, **kwargs: Any) -> AsyncOpenAI:
        clients = self._clients.setdefault(asyncio.get_running_loop(), {})
        if provider not in clients:
            clients[provider] = AsyncOpenAI(http_client=DefaultAioHttpClient(), **kwargs)
        return clients[provider]

    @property
    def openai(self) -> AsyncOpenAI:
        if not config.has_openai:
            raise RuntimeError('OPENAI_API_KEY is not configured.')
        return self._client('openai', api_key=config.openai.api_key)

    @property
    def groq(self) -> AsyncOpenAI:
        if not config.has_groq:
            raise RuntimeError('GROQ_API_KEY is not configured.')
        return self._client('groq', api_key=config.groq.api_key, base_url=GROQ_BASE_URL)

    async def close(self) -> None:
        """Close the running loop's clients (http.run does this when a job ends)."""
        try:
            clients = self._clients.pop(asyncio.get_running_loop(), {})
        except RuntimeError:
            return
        for client in clients.values():
            await client.close()

    async def respond(self, prompt: str, **kwargs: Any) -> str:
        """One OpenAI Responses call (OPENAI_RESPONSE_MODEL, low reasoning effort); the text."""
        response = await self.openai.responses.create(
            model=kwargs.pop('model', config.openai.response_model),
            input=prompt,
            reasoning=kwargs.pop('reasoning', {'effort': 'low'}),
            **kwargs,
        )
        return (response.output_text or '').strip()

    async def groq_chat(self, prompt: str, max_tokens: int, json_mode: bool = False) -> str:
        """One deterministic Groq call at low reasoning effort; returns the message text."""
        kwargs: dict[str, Any] = {
            'model': config.groq.model,
            'messages': [{'role': 'user', 'content': prompt}],
            'temperature': 0,
            'reasoning_effort': 'low',
            'max_tokens': max_tokens,
        }
        if json_mode:
            kwargs['response_format'] = {'type': 'json_object'}
        response = await self.groq.chat.completions.create(**kwargs)
        return (response.choices[0].message.content if response.choices else None) or ''

    async def groq_json(self, system: str | None, user: str, temperature: float = 0, max_tokens: int | None = None) -> str:
        """One JSON-mode Groq completion at low reasoning effort. Returns the raw message content."""
        messages = ([{'role': 'system', 'content': system}] if system else []) + [{'role': 'user', 'content': user}]
        kwargs: dict[str, Any] = {
            'model': config.groq.model,
            'temperature': temperature,
            'reasoning_effort': 'low',
            'response_format': {'type': 'json_object'},
            'messages': messages,
        }
        if max_tokens:
            kwargs['max_tokens'] = max_tokens
        response = await self.groq.chat.completions.create(**kwargs)
        return (response.choices[0].message.content if response.choices else None) or '{}'
