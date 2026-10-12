import { blankInfo } from '../extract.js';
import type { JsonLlm } from '../llm.js';
import { applyQty } from '../rank.js';
import type { Candidate, Listing } from '../types.js';

/** A listing as the LLM step would produce it (overrides on top of sensible defaults). */
export function listing(i: number, overrides: Partial<Listing> = {}): Listing {
  return {
    title: 'LM7805 voltage regulator',
    url: `https://site${i}.com/p/${i}`,
    snippet: '',
    searchRank: i,
    ...blankInfo(),
    cost: 1,
    currency: 'USD',
    costSource: 'llm',
    supplier: `site${i}`,
    inStock: true,
    shippingCost: 'Free',
    shippingTime: '2 days',
    ...overrides,
  };
}

export function candidate(i: number, cost: number | null, qty = 1, overrides: Partial<Listing> = {}): Candidate {
  return applyQty(listing(i, { cost, ...overrides }), qty);
}

/** Records prompts and returns canned replies (one per call, last one repeats) or throws. */
export class FakeLlm implements JsonLlm {
  label = 'fake/model';
  prompts: { system: string; user: string }[] = [];
  constructor(private replies: any[] | ((user: string) => any) = [{}], private error?: string) {}

  async json(system: string, user: string): Promise<any> {
    this.prompts.push({ system, user });
    if (this.error) throw new Error(this.error);
    if (typeof this.replies === 'function') return this.replies(user);
    return this.replies[Math.min(this.prompts.length - 1, this.replies.length - 1)];
  }
}

export const PAGE = `<html><head>
<script type="application/ld+json">{"@type": "Product", "name": "LM7805",
  "offers": {"@type": "Offer", "price": "5.90", "priceCurrency": "USD"}}</script>
<style>.x { color: red }</style></head>
<body><nav>Cart $0.00</nav><h1>LM7805 Regulator (10pcs)</h1>
<s>$9.99</s> $5.90 In stock: 120. Free shipping over $50
<footer>Gift cards from $25</footer></body></html>`;
