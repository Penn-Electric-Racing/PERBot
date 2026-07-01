import OpenAI from 'openai';
import { config, hasGroq } from '../config.js';

/**
 * Groq chat client for the sponsorship module. Groq exposes an OpenAI-compatible
 * endpoint, so we reuse the OpenAI SDK (same pattern as services/llm.ts). Kept
 * separate from the search reranker's client so the sponsorship module stays
 * self-contained.
 */
let client: OpenAI | null = null;

export function getSponsorGroqClient(): OpenAI {
  if (!hasGroq()) {
    throw new Error('GROQ_API_KEY is not configured. It is required for sponsorship enrichment.');
  }
  if (!client) {
    client = new OpenAI({
      apiKey: config.groq.apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return client;
}
