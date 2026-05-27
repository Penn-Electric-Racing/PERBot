/**
 * Parses freeform Slack thread text into the Notion section structure using Groq.
 * Groq runs Llama 3.3 70B via an OpenAI-compatible API — much higher free-tier
 * limits than Gemini and significantly faster.
 */

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

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

export async function parseSubsystemUpdates(
  subsystemName: string,
  threadText: string
): Promise<ParsedUpdate> {
  const prompt = `You are organizing weekly status updates from a Formula SAE Electric racing team into meeting notes.

Below are messages posted by members of the "${subsystemName}" subsystem this week. Bucket each piece of content into the appropriate section.

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
- Don't include image markdown — images are handled separately
- Speaker names in brackets like [Alice] are message authors; attribute naturally or drop attribution if the bullet reads better

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
${threadText}`;

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
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Groq API error ${response.status} for ${subsystemName}: ${errBody}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  const cleaned = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as Partial<ParsedUpdate>;
    return { ...EMPTY_UPDATE, ...parsed };
  } catch (err) {
    console.error(`Failed to parse Groq response for ${subsystemName}:`, text);
    throw new Error(`Groq returned non-JSON for ${subsystemName}: ${err}`);
  }
}
