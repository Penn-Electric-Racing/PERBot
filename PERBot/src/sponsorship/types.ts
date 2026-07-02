/**
 * Shared types + the closed vocabularies for the Sponsorship module.
 *
 * The enum arrays below MUST stay in sync with the live Notion select/multi-select
 * options in the Prospect Bank and Pipeline data sources (verified via the Notion
 * MCP). The LLM classifier and the Notion writer both validate against these, so a
 * drift here silently drops values on write. Update these if the Notion options change.
 */

export const TIERS = ['Tier 1', 'Tier 2', 'Tier 3'] as const;
export type Tier = (typeof TIERS)[number];

export const SPONSOR_TYPES = ['Cash', 'In-Kind'] as const;
export type SponsorType = (typeof SPONSOR_TYPES)[number];

export const CHANNELS = [
  'Vendor',
  'Alumni employer',
  'Competitor sponsor',
  'Category/TAM',
  'Local/Regional',
  'Inbound',
  'Other',
] as const;
export type Channel = (typeof CHANNELS)[number];

export const CATEGORIES = [
  'Aerodynamics',
  'Chassis/DI',
  'Drivetrain',
  'Suspension',
  'Accumulator',
  'Vehicle Dynamics',
  'Electrical Hardware',
  'Manufacturing',
  'Software/CAD',
  'General',
  'Business/Ops',
  'Team-wide',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Bank Status / Relationship — plain enrichment writes Available / New (see guardrails). */
export const BANK_STATUSES = ['Available', 'Claimed', 'Graduated', 'Dead'] as const;
export type BankStatus = (typeof BANK_STATUSES)[number];
export const RELATIONSHIPS = ['New', 'Returning', 'Lapsed'] as const;

/** Pipeline Stage — the 5-stage model. */
export const STAGES = ['Prospect', 'Contacted', 'In talks', 'Won', 'Lost'] as const;
export type Stage = (typeof STAGES)[number];

/**
 * The structured JSON the LLM is forced to return. Contact data is deliberately
 * NOT part of this — the LLM never invents contacts (guardrail); those come only
 * from Hunter.
 */
export interface CompanyClassification {
  fitReason: string;
  suggestedAngle: string;
  tier: Tier;
  categories: Category[];
  type: SponsorType;
  channel: Channel;
}

/** A Notion workspace user, for bridging DRI persons to Slack identities. */
export interface NotionUser {
  id: string;
  name: string;
  email: string | null;
}

/** A parsed Pipeline deal row (subset of properties the commands + jobs use). */
export interface PipelineRow {
  id: string;
  url: string;
  company: string;
  stage: Stage | null;
  /** Notion user IDs of the DRI(s). */
  driUserIds: string[];
  dealValue: number | null;
  received: number | null;
  lastContact: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  notes: string;
}

/** A verified contact from Hunter — the ONLY source of contact data. */
export interface HunterContact {
  name: string;
  email: string;
  /** Hunter deliverability verification status, e.g. "valid" | "accept_all" | "unknown". */
  verificationStatus: string;
  /** 0–100 Hunter confidence score. */
  confidence: number;
}

/** Everything needed to write one Prospect Bank row. */
export interface BankRowInput {
  company: string;
  /** Canonical https://<domain> — the dedupe key. */
  domain: string;
  classification: CompanyClassification;
  contact: HunterContact | null;
  /** True when Hunter confidence is low or the email is unverified → surfaced in Notes. */
  needsReview: boolean;
  reviewReason?: string;
  /** Defaults to 'Available'. A directed add with an assignee writes 'Graduated'. */
  status?: BankStatus;
  /** Notion user IDs to set on 'Claimed by' (directed add). */
  claimedByNotionIds?: string[];
}

/** Everything needed to open one Pipeline deal (directed add / graduation). */
export interface PipelineDealInput {
  bankPageId: string;
  company: string;
  driNotionIds: string[];
  type: SponsorType;
  categories: Category[];
  contact: HunterContact | null;
  /** Free-text next step (e.g. "Send first outreach — reduced-cost PCB fab"). */
  nextAction: string;
  /** ISO date the next action is due (feeds the Wednesday stale DM). */
  nextActionDateIso: string;
}

/** Assignment outcome attached to an EnrichResult when a directed add ran. */
export interface AssignmentInfo {
  /** URL of the created Pipeline deal, if one was opened. */
  dealUrl?: string;
  /** Display labels of the assigned DRIs. */
  assignees: string[];
  /** Mentions we couldn't resolve to a Notion user (assignment skipped for them). */
  unresolved: string[];
}

/**
 * Result of an enrichment run, for the CLI + Slack confirmation message.
 * Discriminated on `deduped`: when the domain already exists in the Bank we
 * short-circuit before classifying/spending a Hunter credit, so those fields
 * are absent on that branch.
 */
export type EnrichResult =
  | {
      deduped: true;
      company: string;
      domain: string;
      /** URL of the pre-existing Bank page. */
      bankPageUrl: string;
      assignment?: AssignmentInfo;
    }
  | {
      deduped: false;
      company: string;
      domain: string;
      /** URL of the newly created Bank page. */
      bankPageUrl: string;
      classification: CompanyClassification;
      contact: HunterContact | null;
      needsReview: boolean;
      reviewReason?: string;
      assignment?: AssignmentInfo;
    };
