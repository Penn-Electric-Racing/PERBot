import OpenAI from 'openai';
import { config, hasOpenAI } from '../config.js';
import type { Extraction, OrderNumberKind, Scan, Scene, SlipLine } from './types.js';

/**
 * Photo(s) of a delivery + the Slack text around it → a fixed-schema `Scan`, via the OpenAI
 * vision model (Groq's gpt-oss-120b is text-only). Several photos in one message are read in
 * ONE call. The schema has no price fields: slips print costs, and anything the model never
 * transcribes can never leak into a Slack reply.
 *
 * The message text matters as much as the photo: in #packages people write "Jlc picked up",
 * "Hv wiring is here", "@Elijah cooling tube is here" over a picture of a box or its contents.
 */

export interface SlipImage {
  /** JPEG / PNG / WebP / GIF bytes. */
  data: Buffer;
  mimeType: string;
}

export interface ScanContext {
  /** The message the photo was posted with (Slack mentions already replaced by names). */
  text: string;
  /** The thread's first message, when the photo is a reply. */
  parentText?: string;
}

const ORDER_KINDS: OrderNumberKind[] = ['purchase_order', 'sales_order', 'invoice', 'customer_reference', 'other'];
const SCENES: Scene[] = ['packing_slip', 'shipping_label', 'contents', 'several_packages', 'not_a_delivery'];

const nullableString = { type: ['string', 'null'] } as const;

const LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vendor_part_number', 'manufacturer_part_number', 'description', 'quantity_shipped', 'customer_reference'],
  properties: {
    vendor_part_number: nullableString,
    manufacturer_part_number: nullableString,
    description: nullableString,
    quantity_shipped: { type: ['number', 'null'] },
    customer_reference: nullableString,
  },
} as const;

const PACKAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vendor', 'addressee', 'ship_date', 'order_numbers', 'tracking_numbers', 'lines', 'item_hints'],
  properties: {
    vendor: nullableString,
    addressee: nullableString,
    ship_date: nullableString,
    order_numbers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'value'],
        properties: { kind: { type: 'string', enum: ORDER_KINDS }, value: { type: 'string' } },
      },
    },
    tracking_numbers: { type: 'array', items: { type: 'string' } },
    lines: { type: 'array', items: LINE_SCHEMA },
    item_hints: { type: 'array', items: { type: 'string' } },
  },
} as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scene', 'legible', 'packages'],
  properties: {
    scene: { type: 'string', enum: SCENES },
    legible: { type: 'boolean' },
    packages: { type: 'array', items: PACKAGE_SCHEMA },
  },
} as const;

const PROMPT = `You are reading a photo posted in Penn Electric Racing's #packages Slack channel, where teammates post deliveries
(boxes, mailers, shipping labels, packing slips, or the parts inside). Transcribe only what is visible or stated; never
guess or complete a number you cannot read (use null).

scene — the main thing shown:
  packing_slip (a packing list / invoice / bill of lading listing items), shipping_label (the outside of one package),
  contents (unpacked parts, no readable paperwork), several_packages (two or more separate packages),
  not_a_delivery (food, people, trophies on display, screenshots, memes, shelves or bins showing where things are stored —
  e.g. the message says where something was put, "X in the rev11 substack" — anything that isn't a package that just arrived).
legible — false if there are labels or paperwork but they are too blurry, small, cropped, or far away to read.

packages — one entry per separate package you can tell apart (none for not_a_delivery). For each:
  vendor: who shipped it — the label's FROM/shipper line, the brand printed on the box or tape (DigiKey, McMaster-Carr,
    JLCPCB, Amazon, Mouser...), or the Slack message if it names one ("Jlc picked up" → JLCPCB). Never the carrier
    (UPS, FedEx, USPS, DHL) and never "University of Pennsylvania".
  addressee: the PERSON named on the label (ship-to / attn / consignee), e.g. "Katherine Shen"; null if only the university.
  ship_date: ship date printed on the label or slip, written as YYYY-MM-DD ("SHIP DATE: 28SEP26" → 2026-09-28), else null.
  order_numbers: every order-identifying number, labelled purchase_order (PO / Customer PO), sales_order (vendor order /
    sales order / web order), invoice, customer_reference (REF fields), or other.
  tracking_numbers: carrier tracking numbers.
  lines: item lines from a packing slip or contents label. vendor_part_number = the vendor's catalog number (DigiKey's ends
    in -ND); manufacturer_part_number = the maker's number; quantity_shipped = quantity shipped in this box (0 if
    backordered); customer_reference = per-line reference text if printed.
  item_hints: specific names of what is inside, from the Slack message, a contents label, or clearly recognizable parts
    ("cooling tube", "steering rack", "soldering tips", "heat fins"). Never generic words (box, package, parts, PCBs,
    components, envelope) and never guesses from the box alone. Only for THIS package; empty if unknown.
If the Slack message names items that can't be tied to a specific package in the photo, put them on the first package.

Do not transcribe prices, totals, or account numbers.`;

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!hasOpenAI()) throw new Error('OPENAI_API_KEY is not configured; package arrivals need it to read photos.');
  if (!client) client = new OpenAI({ apiKey: config.openai.apiKey });
  return client;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Words that describe packaging, not contents — the model adds them from looking at a box. */
const GENERIC_HINT = /^(?:(?:small|large|medium|big|multiple|some|various|assorted|misc\.?|bubble[- ]wrapped)\s+)*(?:pcbs?|boards?|parts?|components?|electronic components|electronics|items?|stuff|supplies|hardware)$/i;
const PACKAGING = /\b(?:box(?:es)?|envelopes?|mailers?|packages?|parcels?|corrugated?|cardboard|poster|padded|bubble|tape|labels?|pallets?|packing)\b/i;

export function isSpecificHint(hint: string): boolean {
  const h = hint.trim();
  return h.length >= 3 && !GENERIC_HINT.test(h) && !PACKAGING.test(h);
}

function parsePackage(o: any): Extraction {
  const lines: SlipLine[] = (Array.isArray(o?.lines) ? o.lines : []).map((l: any) => ({
    vendorPartNumber: str(l?.vendor_part_number),
    manufacturerPartNumber: str(l?.manufacturer_part_number),
    description: str(l?.description),
    quantityShipped: typeof l?.quantity_shipped === 'number' && Number.isFinite(l.quantity_shipped) ? l.quantity_shipped : null,
    customerReference: str(l?.customer_reference),
  }));
  return {
    vendor: str(o?.vendor),
    addressee: str(o?.addressee),
    shipDate: isoDate(o?.ship_date),
    orderNumbers: (Array.isArray(o?.order_numbers) ? o.order_numbers : [])
      .map((n: any) => ({ kind: ORDER_KINDS.includes(n?.kind) ? n.kind : 'other', value: str(n?.value) ?? '' }))
      .filter((n: { value: string }) => n.value),
    trackingNumbers: (Array.isArray(o?.tracking_numbers) ? o.tracking_numbers : []).map(str).filter(Boolean) as string[],
    lines: lines.filter((l) => l.vendorPartNumber || l.manufacturerPartNumber || l.customerReference || l.description),
    itemHints: ((Array.isArray(o?.item_hints) ? o.item_hints : []).map(str).filter(Boolean) as string[]).filter(isSpecificHint).slice(0, 12),
  };
}

/** Validate the model's JSON into a Scan (strict schema should already hold; never trust it blindly). */
export function parseScan(raw: unknown): Scan {
  const o = (raw ?? {}) as Record<string, any>;
  const scene: Scene = SCENES.includes(o.scene) ? o.scene : 'not_a_delivery';
  const packages = scene === 'not_a_delivery' ? [] : (Array.isArray(o.packages) ? o.packages : []).slice(0, 6).map(parsePackage);
  return { scene, legible: o.legible === true, packages };
}

export async function scanPhotos(images: SlipImage[], context: ScanContext): Promise<Scan> {
  const said = [
    context.parentText ? `Thread started with: ${JSON.stringify(context.parentText.slice(0, 500))}` : '',
    `Message posted with the photo: ${JSON.stringify((context.text || '(no text)').slice(0, 500))}`,
  ]
    .filter(Boolean)
    .join('\n');
  const response = await openai().responses.create({
    model: config.arrivals.visionModel,
    reasoning: { effort: 'low' },
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: `${PROMPT}\n\n${said}` },
          ...images.map((img) => ({
            type: 'input_image' as const,
            image_url: `data:${img.mimeType};base64,${img.data.toString('base64')}`,
            detail: 'high' as const,
          })),
        ],
      },
    ],
    text: { format: { type: 'json_schema', name: 'delivery_scan', strict: true, schema: SCHEMA as any } },
  });
  return parseScan(JSON.parse(response.output_text || '{}'));
}
