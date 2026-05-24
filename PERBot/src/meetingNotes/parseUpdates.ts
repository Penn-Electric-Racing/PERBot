import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

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

/**
 * Send the concatenated thread text to Gemini and ask it to bucket
 * each piece into the appropriate Notion section. Returns structured content.
 */
export async function parseSubsystemUpdates(
  subsystemName: string,
  threadText: string
): Promise<ParsedUpdate> {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  });

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
- Speaker names in brackets like [Alice] are message authors; you can attribute things to them naturally ("Alice ordered the elcon charger") or drop the attribution if the bullet reads better without it

Return ONLY a JSON object with these exact keys:
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

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  // Strip fences just in case
  const cleaned = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as Partial<ParsedUpdate>;
    return { ...EMPTY_UPDATE, ...parsed };
  } catch (err) {
    console.error(`Failed to parse Gemini response for ${subsystemName}:`, text);
    throw new Error(`Gemini returned non-JSON for ${subsystemName}: ${err}`);
  }
}
