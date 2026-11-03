/**
 * Turn a plain `{ "Column name": value }` object into Notion property payloads, using the data
 * source's live schema for each column's type. Lets seed data be written as simple JSON and keeps
 * working when the sandbox is missing a column (it's skipped and reported, not a crash).
 */

export type PlainValue = string | number | boolean | string[] | null | undefined;
export type PlainRow = Record<string, PlainValue>;
/** Column name → Notion property type (e.g. `title`, `number`, `formula`). */
export type Schema = Record<string, string>;

export interface ConvertResult {
  properties: Record<string, unknown>;
  /** Columns in the row that the sandbox doesn't have. */
  missing: string[];
  /** Columns that exist but can't be written (formula, rollup, people, …). */
  unwritable: string[];
}

function richText(value: string) {
  return value ? [{ type: 'text', text: { content: value.slice(0, 2000) } }] : [];
}

function asList(value: PlainValue): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

/** One property payload, or undefined when the type isn't writable from a plain value. */
export function toPropertyValue(type: string, value: PlainValue): unknown {
  const str = value === null || value === undefined ? '' : String(value);
  switch (type) {
    case 'title':
      return { title: richText(str) };
    case 'rich_text':
      return { rich_text: richText(str) };
    case 'number':
      return { number: value === null || value === undefined || value === '' ? null : Number(value) };
    case 'checkbox':
      return { checkbox: value === true || ['true', 'yes', '1'].includes(str.toLowerCase()) };
    case 'select':
      return { select: str ? { name: str } : null };
    case 'status':
      return { status: str ? { name: str } : null };
    case 'multi_select':
      return { multi_select: asList(value).map((name) => ({ name })) };
    case 'url':
      return { url: str || null };
    case 'email':
      return { email: str || null };
    case 'phone_number':
      return { phone_number: str || null };
    case 'date':
      return { date: str ? { start: str } : null };
    default:
      return undefined;
  }
}

export function toProperties(row: PlainRow, schema: Schema): ConvertResult {
  const result: ConvertResult = { properties: {}, missing: [], unwritable: [] };
  for (const [name, value] of Object.entries(row)) {
    if (value === undefined) continue;
    const type = schema[name];
    if (!type) {
      result.missing.push(name);
      continue;
    }
    const payload = toPropertyValue(type, value);
    if (payload === undefined) result.unwritable.push(name);
    else result.properties[name] = payload;
  }
  return result;
}
