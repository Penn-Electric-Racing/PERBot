"""Hybrid parser for subsystem update threads.

  1. Each message is scanned for section headers ("Complete:", "Design:", etc).
  2. Content under a header is bucketed deterministically (no LLM).
  3. Content NOT under a header — either entire freeform messages or pre-header lines within a
     structured message — gets collected and sent to Groq in a single batch call per subsystem
     for LLM-based bucketing.

Result: members can use headers for precision OR write naturally. Both work.
Free-tier Groq cost: 1 call per subsystem per week (6 calls/week total).
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field, fields

import httpx

GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
# Read from GROQ_MODEL directly (like GROQ_API_KEY below) to keep this GitHub Actions entrypoint
# decoupled from the app config, which requires Slack/Notion env vars this job doesn't have.
GROQ_MODEL = (os.environ.get('GROQ_MODEL') or '').strip() or 'openai/gpt-oss-120b'

SECTION_KEYS = (
    'logisticalUpdates', 'designUpdates', 'manufacturingUpdates', 'overdueItems', 'lookAhead',
    'deadlines', 'complete', 'incomplete',
)


@dataclass
class ParsedUpdate:
    logisticalUpdates: str = ''
    designUpdates: str = ''
    manufacturingUpdates: str = ''
    overdueItems: str = ''
    lookAhead: str = ''
    deadlines: str = ''
    complete: str = ''
    incomplete: str = ''


EMPTY_UPDATE = ParsedUpdate()


@dataclass
class ProcessedMessage:
    author: str
    text: str
    image_count: int
    permalink: str | None


# Lowercase header keyword → ParsedUpdate field
HEADER_MAP = {
    'complete': 'complete',
    'completed': 'complete',
    'done': 'complete',
    'incomplete': 'incomplete',
    'not done': 'incomplete',
    'in progress': 'incomplete',
    'wip': 'incomplete',
    'deadlines': 'deadlines',
    'deadline': 'deadlines',
    'logistical': 'logisticalUpdates',
    'logistical updates': 'logisticalUpdates',
    'logistics': 'logisticalUpdates',
    'design': 'designUpdates',
    'design updates': 'designUpdates',
    'manufacturing': 'manufacturingUpdates',
    'manufacturing updates': 'manufacturingUpdates',
    'mfg': 'manufacturingUpdates',
    'overdue': 'overdueItems',
    'overdue items': 'overdueItems',
    'catchup': 'overdueItems',
    'catch-up': 'overdueItems',
    'lookahead': 'lookAhead',
    'look ahead': 'lookAhead',
    'look-ahead': 'lookAhead',
    '14-day': 'lookAhead',
    '14 day': 'lookAhead',
    '14-day look-ahead': 'lookAhead',
}


def detect_header(line: str) -> tuple[str, str] | None:
    """(section, inline content) when the line is a recognized section header."""
    stripped = line.strip()
    stripped = re.sub(r'^(?:[-*•·]|\d+\.)\s+', '', stripped)
    stripped = re.sub(r'[*_]+$', '', re.sub(r'^[*_]+', '', stripped))

    # "Header: optional content"
    m = re.match(r'^([A-Za-z][A-Za-z\s/0-9-]*?)[*_]*\s*:\s*(.*)$', stripped, re.S)
    if m:
        section = HEADER_MAP.get(m.group(1).lower().strip())
        if section:
            return section, m.group(2).strip()

    # Bare header on its own line, no colon
    m = re.match(r'^([A-Za-z][A-Za-z\s/0-9-]*?)[*_]*\s*$', stripped)
    if m:
        section = HEADER_MAP.get(m.group(1).lower().strip())
        if section:
            return section, ''
    return None


@dataclass
class _SingleMessageResult:
    buckets: dict[str, list[str]] = field(default_factory=dict)
    sections_used: list[str] = field(default_factory=list)  # ordered set
    freeform_lines: list[str] = field(default_factory=list)
    has_any_header: bool = False


def _parse_single_message(text: str) -> _SingleMessageResult:
    r = _SingleMessageResult()
    current: str | None = None
    for raw_line in text.split('\n'):
        line = raw_line.strip()
        if not line:
            continue
        header = detect_header(line)
        if header:
            r.has_any_header = True
            current = header[0]
            if current not in r.sections_used:
                r.sections_used.append(current)
            if header[1]:
                r.buckets.setdefault(current, []).append(header[1])
            continue
        if current:
            # Continuation under header
            content = re.sub(r'^\d+\.\s+', '', re.sub(r'^[-*•·]\s+', '', line))
            if content:
                r.buckets.setdefault(current, []).append(content)
        else:
            # Pre-header content (or message has no headers at all) → freeform
            r.freeform_lines.append(line)
    return r


def _llm_bucketize(subsystem_name: str, freeform_text: str) -> dict[str, str]:
    """Send accumulated freeform content to Groq and return bucketed result. Returns an empty dict
    if no API key or the call fails (graceful degradation)."""
    if not freeform_text.strip():
        return {}
    api_key = os.environ.get('GROQ_API_KEY')
    if not api_key:
        print(f'GROQ_API_KEY not set — skipping LLM bucketing for {subsystem_name} freeform content')
        return {}

    prompt = f"""You are organizing freeform weekly status updates from a Formula SAE Electric racing team into meeting notes.

The text below contains updates from the "{subsystem_name}" subsystem that members wrote without using explicit section headers. Bucket each piece of content into the appropriate section.

SECTIONS:
- logisticalUpdates — purchases, orders, deliveries, scheduling, coordination, admin
- designUpdates — CAD changes, design issues, PDR/CDR feedback, calculations, simulations
- manufacturingUpdates — fabrication progress, machining, 3D printing, assembly, physical testing
- overdueItems — anything explicitly behind schedule plus the plan to catch up
- lookAhead — plans for the next two weeks
- deadlines — explicit deadlines mentioned (short phrases, one per line)
- complete — tasks/milestones finished this week (short phrases, one per line)
- incomplete — tasks/milestones explicitly NOT done or still in progress (short phrases, one per line)

RULES:
- Preserve the original member's wording and tone where possible — light editing only
- Use markdown bullet points (lines starting with "- ") for the main sections
- For deadlines/complete/incomplete: short phrases, one per line, no leading dash
- If a section has no relevant content, return an empty string ""
- Don't invent content. Only use what's in the messages.
- Speaker names in brackets like [Alice] are message authors; attribute naturally or drop attribution if it reads better

Return ONLY a JSON object with these exact keys, no other text:
{{
  "logisticalUpdates": "- bullet\\n- bullet",
  "designUpdates": "",
  "manufacturingUpdates": "",
  "overdueItems": "",
  "lookAhead": "",
  "deadlines": "",
  "complete": "",
  "incomplete": ""
}}

MESSAGES:
{freeform_text}"""

    try:
        response = httpx.post(
            GROQ_API_URL,
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json={
                'model': GROQ_MODEL,
                'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0.2,
                # gpt-oss-120b is a reasoning model; keep reasoning minimal for this bounded bucketing task.
                'reasoning_effort': 'low',
                'response_format': {'type': 'json_object'},
            },
            timeout=120,
        )
        if not response.is_success:
            print(f'Groq API error {response.status_code} for {subsystem_name}: {response.text}')
            return {}
        data = response.json()
        text = ((data.get('choices') or [{}])[0].get('message') or {}).get('content') or ''
        parsed = json.loads(re.sub(r'```json|```', '', text).strip())
        return parsed if isinstance(parsed, dict) else {}
    except Exception as err:
        print(f'Groq call failed for {subsystem_name}: {err}')
        return {}


def parse_subsystem_updates(subsystem_name: str, messages: list[ProcessedMessage]) -> ParsedUpdate:
    accumulators: dict[str, list[str]] = {k: [] for k in SECTION_KEYS}
    freeform_chunks: list[str] = []

    for msg in messages:
        r = _parse_single_message(msg.text)

        # Header-bucketed content
        for section, items in r.buckets.items():
            accumulators[section].extend(items)

        # Collect freeform content for batched LLM call
        if r.freeform_lines:
            freeform_chunks.append(f'[{msg.author}]\n' + '\n'.join(r.freeform_lines))

        # Attach image references
        if msg.image_count > 0 and msg.permalink:
            noun = 'image' if msg.image_count == 1 else 'images'
            image_note = f'📷 {msg.image_count} {noun} from {msg.author} — view in Slack thread'
            if r.sections_used:
                for section in r.sections_used:
                    accumulators[section].append(image_note)
            else:
                # Fully freeform message with images (or images outside any header) — designUpdates default
                accumulators['designUpdates'].append(image_note)

    # Single batched LLM call for all freeform content from this subsystem
    if freeform_chunks:
        print(f'[{subsystem_name}] Sending {len(freeform_chunks)} freeform chunk(s) to Groq...')
        llm_result = _llm_bucketize(subsystem_name, '\n\n'.join(freeform_chunks))
        for key, value in llm_result.items():
            if key in accumulators and isinstance(value, str) and value.strip():
                # Split LLM output into individual items, strip leading bullet markers
                items = [s for s in (re.sub(r'^[-*•·]\s*', '', x).strip() for x in value.split('\n')) if s]
                accumulators[key].extend(items)

    return ParsedUpdate(**{k: '\n'.join(v) for k, v in accumulators.items()})


assert {f.name for f in fields(ParsedUpdate)} == set(SECTION_KEYS)
