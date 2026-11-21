from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from dataclasses import dataclass
from typing import Callable, Literal

import numpy as np
import openai
from openai import AsyncOpenAI

from core.config import config
from core.llm import LLM

logger = logging.getLogger(__name__)

__all__ = [
    'EMBEDDING_BATCH_SIZE', 'MAX_EMBED_RETRIES', 'get_openai_client', 'embed_texts',
    'embed_query', 'RerankCandidate', 'rerank_results', 'AnswerSource', 'NO_OPENAI_NOTE',
    'answer_from_sources', 'MentionIntent', 'THREAD_HINT', 'heuristic_intent',
    'classify_mention', 'ThreadMessage', 'summarize_thread',
]

# Embedding requests carry up to this many inputs (OpenAI allows 2048; chunks are ≤ ~400 tokens).
EMBEDDING_BATCH_SIZE = 100
MAX_EMBED_RETRIES = 8

def get_openai_client() -> AsyncOpenAI:
    if not config.has_openai:
        raise RuntimeError('OPENAI_API_KEY is not configured. Embeddings are required for search to function.')
    return LLM.shared().openai


def _normalize(vec: np.ndarray) -> np.ndarray:
    mag = float(np.sqrt(np.dot(vec.astype(np.float64), vec.astype(np.float64))))
    return (vec / mag).astype(np.float32) if mag > 0 else vec


async def _create_embedding_with_retry(client: AsyncOpenAI, texts: list[str]):
    attempt = 0
    while True:
        try:
            return await client.embeddings.create(
                model=config.openai.embedding_model,
                input=texts,
                encoding_format='float',
                dimensions=config.openai.embedding_dims,
            )
        except Exception as err:
            status = getattr(err, 'status_code', None)
            retryable = (
                isinstance(err, (openai.RateLimitError, openai.APIConnectionError, openai.APITimeoutError))
                or (status is not None and status >= 500)
                or 'Rate limit' in str(err)
            )
            if not retryable or attempt >= MAX_EMBED_RETRIES:
                raise
            delay = min(90_000, 2_000 * 2**attempt)
            logger.warning(
                f"Embedding request failed ({status or type(err).__name__}). Retry {attempt + 1}/{MAX_EMBED_RETRIES} in {delay}ms"
            )
            await asyncio.sleep(delay / 1000)
            attempt += 1


async def embed_texts(texts: list[str], on_batch: Callable[[int, int], None] | None = None) -> list[np.ndarray]:
    """Unit-normalized embeddings (float32), in input order."""
    if not texts:
        return []
    client = get_openai_client()
    out: list[np.ndarray] = []
    total_batches = math.ceil(len(texts) / EMBEDDING_BATCH_SIZE)
    for i in range(0, len(texts), EMBEDDING_BATCH_SIZE):
        batch = texts[i : i + EMBEDDING_BATCH_SIZE]
        response = await _create_embedding_with_retry(client, batch)
        for item in response.data:
            out.append(_normalize(np.asarray(item.embedding, dtype=np.float32)))
        if on_batch:
            on_batch(i // EMBEDDING_BATCH_SIZE + 1, total_batches)
    return out


async def embed_query(text: str) -> np.ndarray:
    vectors = await embed_texts([text])
    if not vectors:
        raise RuntimeError('Embedding returned empty result for query.')
    return vectors[0]




# ---------------------------------------------------------------------------------------------
# Reranker (Groq)
# ---------------------------------------------------------------------------------------------


@dataclass
class RerankCandidate:
    page_id: str
    title: str
    path_text: str
    text: str


def _parse_index_list(raw: str, n: int) -> list[int] | None:
    """Parses `[{"i":2},{"i":0}]` (preferred) or a bare `[2,0]` into an index list."""
    cleaned = re.sub(r'```[a-z]*\n?', '', raw).replace('```', '').strip()
    start = cleaned.find('[')
    end = cleaned.rfind(']')
    if start == -1 or end == -1:
        return None
    try:
        parsed = json.loads(cleaned[start : end + 1])
    except ValueError:
        return None
    if not isinstance(parsed, list):
        return None
    out: list[int] = []
    for item in parsed:
        v = item if isinstance(item, (int, float)) and not isinstance(item, bool) else (
            item.get('i') if isinstance(item, dict) else None
        )
        if isinstance(v, float) and v.is_integer():
            v = int(v)
        if isinstance(v, int) and not isinstance(v, bool) and 0 <= v < n and v not in out:
            out.append(v)
    return out or None


async def rerank_results(query: str, candidates: list[RerankCandidate]) -> list[str]:
    """Orders candidates by relevance. Falls back to the incoming order (already RRF-fused) when
    Groq is unavailable or returns something unparsable. Candidates carry the full best chunk
    (capped by the caller)."""
    fallback = [c.page_id for c in candidates]
    if len(candidates) < 2 or not config.has_groq:
        return fallback

    listing = '\n\n'.join(f'[{i}] {c.title}  ({c.path_text})\n{c.text}' for i, c in enumerate(candidates))

    # gpt-oss-120b at low reasoning has emitted bare-number arrays without commas; single-key
    # objects force separators.
    prompt = f"""You rank documentation pages from Penn Electric Racing's Notion for a teammate's question.
Order ALL candidates from most to least useful for answering the question. Prefer pages that directly
document the thing asked about over meeting notes that merely mention it; prefer current-season
material over older REVs unless the question asks about history.

Question: {query}

Candidates:
{listing}

Reply with ONLY a JSON array of objects like [{{"i": 2}}, {{"i": 0}}, ...] covering every index once."""

    try:
        raw = await LLM.shared().groq_chat(prompt, 1024)
        order = _parse_index_list(raw, len(candidates))
        if not order:
            logger.warning('Reranker returned an unparsable list; keeping fused order.')
            return fallback
        seen = set(order)
        rest = [i for i in range(len(candidates)) if i not in seen]
        return [candidates[i].page_id for i in [*order, *rest]]
    except Exception as err:
        logger.warning('Reranker failed; keeping fused order.', exc_info=err)
        return fallback


# ---------------------------------------------------------------------------------------------
# Answer synthesis (OpenAI)
# ---------------------------------------------------------------------------------------------


@dataclass
class AnswerSource:
    n: int
    title: str
    path_text: str
    url: str
    is_historical: bool
    rev_number: int | None
    text: str


NO_OPENAI_NOTE = (
    'Here are the most relevant PER Notion pages. (Set `OPENAI_API_KEY` for PERBot to write an answer from them.)'
)


async def answer_from_sources(query: str, sources: list[AnswerSource], weak: bool) -> str:
    if not config.has_openai:
        return NO_OPENAI_NOTE
    if not sources:
        return 'I could not find anything relevant in the indexed PER docs.'

    def fmt(s: AnswerSource) -> str:
        tags = ', '.join(
            t for t in [f'REV{s.rev_number}' if s.rev_number else None, 'HISTORICAL (older season)' if s.is_historical else None] if t
        )
        return f"[{s.n}] {s.title}{f' — {tags}' if tags else ''}\nLocation: {s.path_text}\n{s.text}"

    source_text = '\n\n---\n\n'.join(fmt(s) for s in sources)

    confidence = (
        'Retrieval confidence is LOW: the sources may not cover this question. If they do not, say so in one sentence and name the closest page instead of guessing.'
        if weak
        else 'If the sources only partly answer the question, say what is covered and what is not.'
    )

    prompt = f"""You are PERBot, the documentation assistant for Penn Electric Racing (Penn's Formula SAE Electric team).
Answer the teammate's question using ONLY the sources below.

Rules:
- Cite sources inline like [1] or [2][3]. Every factual sentence needs a citation.
- {confidence}
- Say when something comes from a historical (older REV) page.
- Do not invent facts, names, numbers, or part choices.
- 3–6 sentences in Slack mrkdwn: *bold* for key terms, no headers, no markdown links.

Question: {query}

Sources:
{source_text}"""

    return await LLM.shared().respond(prompt) or 'I found relevant pages but could not write a summary.'


# ---------------------------------------------------------------------------------------------
# Mention routing
# ---------------------------------------------------------------------------------------------

MentionIntent = Literal['docs', 'thread', 'chat']

THREAD_HINT = re.compile(
    r'\b(summari[sz]e|tl;?dr|recap|catch me up|what did (?:we|they|\w+) (?:say|decide|conclude)|this thread|the thread|above)\b',
    re.I,
)


def heuristic_intent(text: str, in_thread: bool) -> MentionIntent:
    t = text.strip()
    if in_thread and THREAD_HINT.search(t):
        return 'thread'
    words = [w for w in re.split(r'\s+', re.sub(r'[^\w\s]|_', ' ', t)) if w]
    if t.endswith('?') or len(words) >= 3:
        return 'docs'
    return 'chat'


async def classify_mention(text: str, in_thread: bool) -> MentionIntent:
    """Decides what a `@PERBot …` mention is asking for. Heuristics catch the obvious cases; Groq
    settles the rest ("let her re-send it" is chatter, "how is the PCM box wired" is docs)."""
    guess = heuristic_intent(text, in_thread)
    if not config.has_groq:
        return guess
    if guess == 'thread':
        return guess

    prompt = f"""Classify a Slack message addressed to PERBot, a bot that answers questions from Penn Electric Racing's engineering documentation.
Intents:
- "docs": a question or request for information about the team, the car, its subsystems, processes, tools, parts, or history — anything a documentation search could answer.
- "thread": asks PERBot to summarize, recap, or answer from the current conversation thread (only possible when in_thread is true).
- "chat": banter, reactions, jokes, instructions to people, insults, thanks, or anything that is not an information request.

in_thread: {'true' if in_thread else 'false'}
message: {json.dumps(text[:500], ensure_ascii=False)}

Reply with ONLY JSON: {{"intent": "docs" | "thread" | "chat"}}"""

    try:
        parsed = json.loads(await LLM.shared().groq_chat(prompt, 200, json_mode=True))
        intent = parsed.get('intent') if isinstance(parsed, dict) else None
        if intent == 'thread' and not in_thread:
            return 'docs'
        if intent in ('docs', 'thread', 'chat'):
            return intent
    except Exception as err:
        logger.warning('Mention classifier failed; using heuristic.', exc_info=err)
    return guess


@dataclass
class ThreadMessage:
    name: str
    text: str


async def summarize_thread(request: str, messages: list[ThreadMessage]) -> str:
    """Answers a request about the thread ("summarize this", "what did we decide on X") from its messages."""
    if not config.has_openai:
        return 'I need `OPENAI_API_KEY` configured to summarize threads.'
    max_chars = 60_000
    transcript = '\n\n'.join(f'{m.name}: {m.text}' for m in messages)
    if len(transcript) > max_chars:
        transcript = f'{transcript[:max_chars]}\n\n[… thread truncated …]'
    prompt = f"""You are PERBot, a helpful assistant in Penn Electric Racing's Slack. A teammate asked, inside a thread: {json.dumps(request, ensure_ascii=False)}.
Answer from the thread transcript only. For a summary: lead with the decisions or conclusions, then the open questions, then who is doing what — as short Slack mrkdwn bullets (use "•" and *bold*, no headers). Attribute positions to people by name. Keep it under ~180 words. Do not invent anything not in the transcript.

Thread transcript:
{transcript}"""

    return await LLM.shared().respond(prompt) or 'I could not summarize that thread.'
