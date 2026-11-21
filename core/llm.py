"""The bot's language models, for every feature: `LLM.shared()`.

  OpenAI (OPENAI_API_KEY)  written answers, photo reading, structured output: `respond`, `.openai`
  Groq   (GROQ_API_KEY)    fast bounded tasks (classify, rerank, enrich): `groq_chat`, `groq_json`

Groq exposes an OpenAI-compatible endpoint, so both are the OpenAI SDK. The clients are built on
first use, so a feature that never calls a model never needs its key.
"""
from __future__ import annotations

import threading
from typing import Any, ClassVar

from openai import OpenAI

from core.config import config

__all__ = ['GROQ_BASE_URL', 'LLM']

GROQ_BASE_URL = 'https://api.groq.com/openai/v1'


class LLM:
    _shared: ClassVar['LLM | None'] = None
    _lock: ClassVar[threading.Lock] = threading.Lock()

    @classmethod
    def shared(cls) -> 'LLM':
        with cls._lock:
            if cls._shared is None:
                cls._shared = cls()
            return cls._shared

    def __init__(self) -> None:
        self._openai: OpenAI | None = None
        self._groq: OpenAI | None = None
        self._clients_lock = threading.Lock()

    @property
    def openai(self) -> OpenAI:
        if not config.has_openai:
            raise RuntimeError('OPENAI_API_KEY is not configured.')
        with self._clients_lock:
            if self._openai is None:
                self._openai = OpenAI(api_key=config.openai.api_key)
            return self._openai

    @property
    def groq(self) -> OpenAI:
        if not config.has_groq:
            raise RuntimeError('GROQ_API_KEY is not configured.')
        with self._clients_lock:
            if self._groq is None:
                self._groq = OpenAI(api_key=config.groq.api_key, base_url=GROQ_BASE_URL)
            return self._groq

    def respond(self, prompt: str, **kwargs: Any) -> str:
        """One OpenAI Responses call (OPENAI_RESPONSE_MODEL, low reasoning effort); the text."""
        response = self.openai.responses.create(
            model=kwargs.pop('model', config.openai.response_model),
            input=prompt,
            reasoning=kwargs.pop('reasoning', {'effort': 'low'}),
            **kwargs,
        )
        return (response.output_text or '').strip()

    def groq_chat(self, prompt: str, max_tokens: int, json_mode: bool = False) -> str:
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
        response = self.groq.chat.completions.create(**kwargs)
        return (response.choices[0].message.content if response.choices else None) or ''

    def groq_json(self, system: str | None, user: str, temperature: float = 0, max_tokens: int | None = None) -> str:
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
        response = self.groq.chat.completions.create(**kwargs)
        return (response.choices[0].message.content if response.choices else None) or '{}'
