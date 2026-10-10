import OpenAI from 'openai';
import { config, hasOpenAI } from '../config.js';
import type { Extraction, OrderNumberKind, SlipLine } from './types.js';

/**
 * Photo(s) of one package → a fixed-schema `Extraction`, via the OpenAI vision model (Groq's
 * gpt-oss-120b is text-only). Several photos of the same box (label + slip) go in ONE call, so
 * they're read as one package. The schema has no price fields: slips print costs, and anything
 * the model never transcribes can never leak into a Slack reply.
 */

export interface SlipImage {
  /** JPEG / PNG / WebP / GIF bytes. */
  data: Buffer;
  mimeType: string;
}

const ORDER_KINDS: OrderNumberKind[] = ['purchase_order', 'sales_order', 'invoice', 'customer_reference', 'other'];

const nullableString = { type: ['string', 'null'] } as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_shipping_document', 'legible', 'vendor', 'order_numbers', 'tracking_numbers', 'lines'],
  properties: {
    is_shipping_document: { type: 'boolean' },
    legible: { type: 'boolean' },
    vendor: nullableString,
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
    lines: {
      type: 'array',
      items: {
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
      },
    },
  },
} as const;

const PROMPT = `These photos show ONE package delivered to Penn Electric Racing: a packing slip, a shipping label, or both.
Transcribe exactly what is printed. Never guess or complete a number you cannot read; use null instead.

- is_shipping_document: true if any photo shows a packing slip, invoice, or shipping label.
- legible: false if the part numbers or order numbers are too blurry, cropped, or glared to read reliably.
- vendor: the company that shipped it (e.g. "DigiKey", "McMaster-Carr", "Mouser"), not the carrier (UPS/FedEx/USPS).
- order_numbers: every order-identifying number, labelled: purchase_order (PO / Customer PO / Your order),
  sales_order (the vendor's order / sales order / web order number), invoice, customer_reference, or other.
- tracking_numbers: carrier tracking numbers.
- lines: one entry per item line on the slip. vendor_part_number is the vendor's catalog number (DigiKey's ends in -ND);
  manufacturer_part_number is the maker's number; quantity_shipped is the quantity shipped in this box (0 if backordered);
  customer_reference is the per-line reference/customer text if printed.

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

/** Validate the model's JSON into an Extraction (strict schema should already hold; never trust it blindly). */
export function parseExtraction(raw: unknown): Extraction {
  const o = (raw ?? {}) as Record<string, any>;
  const lines: SlipLine[] = (Array.isArray(o.lines) ? o.lines : []).map((l: any) => ({
    vendorPartNumber: str(l?.vendor_part_number),
    manufacturerPartNumber: str(l?.manufacturer_part_number),
    description: str(l?.description),
    quantityShipped: typeof l?.quantity_shipped === 'number' && Number.isFinite(l.quantity_shipped) ? l.quantity_shipped : null,
    customerReference: str(l?.customer_reference),
  }));
  return {
    isShippingDocument: o.is_shipping_document === true,
    legible: o.legible === true,
    vendor: str(o.vendor),
    orderNumbers: (Array.isArray(o.order_numbers) ? o.order_numbers : [])
      .map((n: any) => ({ kind: ORDER_KINDS.includes(n?.kind) ? n.kind : 'other', value: str(n?.value) ?? '' }))
      .filter((n: { value: string }) => n.value),
    trackingNumbers: (Array.isArray(o.tracking_numbers) ? o.tracking_numbers : []).map(str).filter(Boolean) as string[],
    lines: lines.filter((l) => l.vendorPartNumber || l.manufacturerPartNumber || l.customerReference),
  };
}

export async function extractSlip(images: SlipImage[]): Promise<Extraction> {
  const response = await openai().responses.create({
    model: config.arrivals.visionModel,
    reasoning: { effort: 'low' },
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: PROMPT },
          ...images.map((img) => ({
            type: 'input_image' as const,
            image_url: `data:${img.mimeType};base64,${img.data.toString('base64')}`,
            detail: 'high' as const,
          })),
        ],
      },
    ],
    text: { format: { type: 'json_schema', name: 'packing_slip', strict: true, schema: SCHEMA as any } },
  });
  return parseExtraction(JSON.parse(response.output_text || '{}'));
}
