"""Groq chat client for the sponsorship module. Groq exposes an OpenAI-compatible endpoint, so we
reuse the OpenAI SDK (same pattern as services/llm.py). Kept separate from the search reranker's
client so the sponsorship module stays self-contained."""
from __future__ import annotations

from openai import OpenAI

from ..config import config, has_groq

_client: OpenAI | None = None


def get_sponsor_groq_client() -> OpenAI:
    global _client
    if not has_groq():
        raise RuntimeError('GROQ_API_KEY is not configured. It is required for sponsorship enrichment.')
    if _client is None:
        _client = OpenAI(api_key=config.groq.api_key, base_url='https://api.groq.com/openai/v1')
    return _client


def groq_json(system: str | None, user: str, temperature: float = 0, max_tokens: int | None = None) -> str:
    """One JSON-mode chat completion at low reasoning effort (gpt-oss-120b is a reasoning model;
    these are bounded tasks). Returns the raw message content."""
    messages = ([{'role': 'system', 'content': system}] if system else []) + [{'role': 'user', 'content': user}]
    kwargs: dict = {
        'model': config.groq.model,
        'temperature': temperature,
        'reasoning_effort': 'low',
        'response_format': {'type': 'json_object'},
        'messages': messages,
    }
    if max_tokens:
        kwargs['max_tokens'] = max_tokens
    response = get_sponsor_groq_client().chat.completions.create(**kwargs)
    return (response.choices[0].message.content if response.choices else None) or '{}'
