import { money } from './prep.js';
import type { VendorAdapter } from './types.js';

/** The requisition email, ready for any transport. */
export interface RequisitionEmail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  approvalRequired: boolean;
}

export interface EmailInput {
  requisitionNumber: string;
  /** The BEN order total as typed by the operator. */
  total: number;
  /** Distinct cart lines post-aggregation — how BEN counts line items. */
  lineCount: number;
  from: string;
  cc: string[];
  approvalThreshold: number;
}

export function buildRequisitionEmail(adapter: VendorAdapter, input: EmailInput): RequisitionEmail {
  const approvalRequired = input.total > input.approvalThreshold;
  const tag = approvalRequired ? '[APPROVAL REQUIRED]' : '[NO APPROVAL REQUIRED]';
  const items = `${input.lineCount} line item${input.lineCount === 1 ? '' : 's'}`;
  const paragraphs = [
    'Hi,',
    `I just placed Requisition ${input.requisitionNumber} on BenBuys for a ${adapter.label} order for ${adapter.subteam}, and the order total is $${money(input.total)} (${items}).${
      approvalRequired ? ' Dr. Tertuliano, do you approve?' : ''
    } Thank you for placing the order!`,
    `Best,\n${adapter.signatureName}`,
  ];
  return {
    from: input.from,
    to: adapter.emailTo,
    cc: input.cc,
    subject: `${tag} PER Requisition ${input.requisitionNumber}`,
    body: paragraphs.join('\n\n'),
    approvalRequired,
  };
}

/** Human-readable rendering for dry runs and the Slack confirmation. */
export function renderEmail(email: RequisitionEmail): string {
  return [
    `From: ${email.from}`,
    `To: ${email.to.join(', ')}`,
    `Cc: ${email.cc.join(', ')}`,
    `Subject: ${email.subject}`,
    '',
    email.body,
  ].join('\n');
}
