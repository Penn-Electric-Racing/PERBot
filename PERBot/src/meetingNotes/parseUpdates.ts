/**
 * Hybrid parser for subsystem update threads.
 *
 *   1. Each message is scanned for section headers ("Complete:", "Design:", etc).
 *   2. Content under a header is bucketed deterministically (no LLM).
 *   3. Content NOT under a header — either entire freeform messages or pre-header
 *      lines within a structured message — gets collected and sent to Groq in a
 *      single batch call per subsystem for LLM-based bucketing.
 *
 * Result: members can use headers for precision OR write naturally. Both work.
 * Free-tier Groq cost: 1 call per subsystem per week (6 calls/week total).
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Read from GROQ_MODEL directly (like GROQ_API_KEY below) to keep this GitHub Actions entrypoint
// decoupled from the app config, which require()s Slack/Notion env vars this job doesn't have.
// llama-3.3-70b-versatile is decommissioned by Groq Aug 16 2026 → openai/gpt-oss-120b.
const GROQ_MODEL = process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b';

export interface ParsedUpdate {
  logisticalUpdates: string;
  designUpdates: string;
  manufacturingUpdates: string;
  overdueItems: string;
  lookAhead: string;
  deadlines: string;
  complete: string;
  incomplete: string;
}

export const EMPTY_UPDATE: ParsedUpdate = {
  logisticalUpdates: '',
  designUpdates: '',
  manufacturingUpdates: '',
  overdueItems: '',
  lookAhead: '',
  deadlines: '',
  complete: '',
  incomplete: '',
};

export interface ProcessedMessage {
  author: string;
  text: string;
  imageCount: number;
  permalink: string | null;
}

// Lowercase header keyword → ParsedUpdate field
const HEADER_MAP: Record<string, keyof ParsedUpdate> = {
  complete: 'complete',
  completed: 'complete',
  done: 'complete',
  incomplete: 'incomplete',
  'not done': 'incomplete',
  'in progress': 'incomplete',
  wip: 'incomplete',
  deadlines: 'deadlines',
  deadline: 'deadlines',
  logistical: 'logisticalUpdates',
  'logistical updates': 'logisticalUpdates',
  logistics: 'logisticalUpdates',
  design: 'designUpdates',
  'design updates': 'designUpdates',
  manufacturing: 'manufacturingUpdates',
  'manufacturing updates': 'manufacturingUpdates',
  mfg: 'manufacturingUpdates',
  overdue: 'overdueItems',
  'overdue items': 'overdueItems',
  catchup: 'overdueItems',
  'catch-up': 'overdueItems',
  lookahead: 'lookAhead',
  'look ahead': 'lookAhead',
  'look-ahead': 'lookAhead',
  '14-day': 'lookAhead',
  '14 day': 'lookAhead',
  '14-day look-ahead': 'lookAhead',
};

function detectHeader(
  line: string
): { section: keyof ParsedUpdate; inlineContent: string } | null {
  let stripped = line.trim();
  stripped = stripped.replace(/^(?:[-*•·]|\d+\.)\s+/, '');
  stripped = stripped.replace(/^[*_]+/, '').replace(/[*_]+$/, '');

  // "Header: optional content"
  let m = stripped.match(/^([A-Za-z][A-Za-z\s/0-9-]*?)[*_]*\s*:\s*(.*)$/);
  if (m) {
    const key = m[1].toLowerCase().trim();
    const section = HEADER_MAP[key];
    if (section) return { section, inlineContent: m[2].trim() };
  }

  // Bare header on its own line, no colon
  m = stripped.match(/^([A-Za-z][A-Za-z\s/0-9-]*?)[*_]*\s*$/);
  if (m) {
    const key = m[1].toLowerCase().trim();
    const section = HEADER_MAP[key];
    if (section) return { section, inlineContent: '' };
  }

  return null;
}

interface SingleMessageResult {
  buckets: Partial<Record<keyof ParsedUpdate, string[]>>;
  sectionsUsed: Set<keyof ParsedUpdate>;
  freeformLines: string[];
  hasAnyHeader: boolean;
}

function parseSingleMessage(text: string): SingleMessageResult {
  const buckets: Partial<Record<keyof ParsedUpdate, string[]>> = {};
  const sectionsUsed = new Set<keyof ParsedUpdate>();
  const freeformLines: string[] = [];
  let currentSection: keyof ParsedUpdate | null = null;
  let hasAnyHeader = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = detectHeader(line);
    if (header) {
      hasAnyHeader = true;
      currentSection = header.section;
      sectionsUsed.add(currentSection);
      if (header.inlineContent) {
        (buckets[currentSection] ??= []).push(header.inlineContent);
      }
      continue;
    }

    if (currentSection) {
      // Continuation under header
      const content = line.replace(/^[-*•·]\s+/, '').replace(/^\d+\.\s+/, '');
      if (content) (buckets[currentSection] ??= []).push(content);
    } else {
      // Pre-header content (or message has no headers at all) → freeform
      freeformLines.push(line);
    }
  }

  return { buckets, sectionsUsed, freeformLines, hasAnyHeader };
}

/**
 * Send accumulated freeform content to Groq and return bucketed result.
 * Returns empty object if no API key or call fails (graceful degradation).
 */
async function llmBucketize(
  subsystemName: string,
  freeformText: string
): Promise<Partial<ParsedUpdate>> {
  if (!freeformText.trim()) return {};
  if (!process.env.GROQ_API_KEY) {
    console.warn(`GROQ_API_KEY not set — skipping LLM bucketing for ${subsystemName} freeform content`);
    return {};
  }

  const prompt = `You are organizing freeform weekly status updates from a Formula SAE Electric racing team into meeting notes.

The text below contains updates from the "${subsystemName}" subsystem that members wrote without using explicit section headers. Bucket each piece of content into the appropriate section.

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
{
  "logisticalUpdates": "- bullet\\n- bullet",
  "designUpdates": "",
  "manufacturingUpdates": "",
  "overdueItems": "",
  "lookAhead": "",
  "deadlines": "",
  "complete": "",
  "incomplete": ""
}

MESSAGES:
${freeformText}`;

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        // gpt-oss-120b is a reasoning model; keep reasoning minimal for this bounded bucketing task.
        reasoning_effort: 'low',
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`Groq API error ${response.status} for ${subsystemName}: ${errBody}`);
      return {};
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned) as Partial<ParsedUpdate>;
  } catch (err) {
    console.error(`Groq call failed for ${subsystemName}:`, err);
    return {};
  }
}

export async function parseSubsystemUpdates(
  subsystemName: string,
  messages: ProcessedMessage[]
): Promise<ParsedUpdate> {
  const accumulators: Record<keyof ParsedUpdate, string[]> = {
    logisticalUpdates: [],
    designUpdates: [],
    manufacturingUpdates: [],
    overdueItems: [],
    lookAhead: [],
    deadlines: [],
    complete: [],
    incomplete: [],
  };

  const freeformChunks: string[] = [];

  for (const msg of messages) {
    const { buckets, sectionsUsed, freeformLines, hasAnyHeader } = parseSingleMessage(msg.text);

    // Header-bucketed content
    for (const [section, items] of Object.entries(buckets)) {
      accumulators[section as keyof ParsedUpdate].push(...items);
    }

    // Collect freeform content for batched LLM call
    if (freeformLines.length > 0) {
      freeformChunks.push(`[${msg.author}]\n${freeformLines.join('\n')}`);
    }

    // Attach image references
    if (msg.imageCount > 0 && msg.permalink) {
      const noun = msg.imageCount === 1 ? 'image' : 'images';
      const imageNote = `📷 ${msg.imageCount} ${noun} from ${msg.author} — view in Slack thread`;
      if (sectionsUsed.size > 0) {
        for (const section of sectionsUsed) accumulators[section].push(imageNote);
      } else if (hasAnyHeader) {
        // Message used headers but image wasn't under any (rare) → designUpdates default
        accumulators.designUpdates.push(imageNote);
      } else {
        // Fully freeform message with images — designUpdates default
        accumulators.designUpdates.push(imageNote);
      }
    }
  }

  // Single batched LLM call for all freeform content from this subsystem
  if (freeformChunks.length > 0) {
    console.log(`[${subsystemName}] Sending ${freeformChunks.length} freeform chunk(s) to Groq...`);
    const llmResult = await llmBucketize(subsystemName, freeformChunks.join('\n\n'));
    for (const key of Object.keys(llmResult) as (keyof ParsedUpdate)[]) {
      const value = llmResult[key];
      if (typeof value === 'string' && value.trim()) {
        // Split LLM output into individual items, strip leading bullet markers
        const items = value
          .split('\n')
          .map((s) => s.replace(/^[-*•·]\s*/, '').trim())
          .filter(Boolean);
        accumulators[key].push(...items);
      }
    }
  }

  const result: ParsedUpdate = { ...EMPTY_UPDATE };
  for (const key of Object.keys(accumulators) as (keyof ParsedUpdate)[]) {
    result[key] = accumulators[key].join('\n');
  }
  return result;
}
