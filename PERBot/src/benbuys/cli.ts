import { config } from '../config.js';
import { resolveAdapter } from './adapters/index.js';
import { buildRequisitionEmail, renderEmail } from './email.js';
import { createMailer } from './mailer.js';
import { PurchasingNotion } from './notion.js';
import { buildPrep, formatPrep } from './prep.js';

/**
 * Local checks without Slack (run from PERBot/PERBot with .env set):
 *   npm run benbuys:prep -- [vendor]        read-only: prints the three prep blocks
 *   npm run benbuys:email -- you@upenn.edu  sends a sample requisition email to YOU only
 *                                           (verifies the Gmail OAuth creds; no Notion writes)
 */
async function main(): Promise<void> {
  const [mode = 'prep', arg] = process.argv.slice(2);
  const adapter = resolveAdapter(mode === 'prep' ? arg : undefined);
  if (!adapter) throw new Error(`Unknown or non-live vendor "${arg}".`);

  if (mode === 'prep') {
    const { ready, notReady } = await new PurchasingNotion().selectRows(adapter);
    const prep = buildPrep(adapter, ready, notReady);
    const blocks = formatPrep(adapter, prep, config.benbuys.approvalThreshold);
    console.log(`--- BLOCK 1: cart (${prep.lines.length} lines) ---\n${blocks.cart}\n`);
    console.log(`--- BLOCK 2: BEN ---\n${blocks.ben}\n`);
    console.log(`--- BLOCK 3: summary ---\n${blocks.summary}`);
    return;
  }

  if (mode === 'email') {
    if (!arg || !arg.includes('@')) throw new Error('Usage: npm run benbuys:email -- you@upenn.edu');
    const mailer = createMailer();
    if (!mailer) throw new Error('No email transport configured (BENBUYS_MAIL_TRANSPORT + creds).');
    const email = buildRequisitionEmail(adapter, {
      requisitionNumber: '0000000',
      total: 123.45,
      lineCount: 3,
      from: config.benbuys.from,
      cc: [],
      approvalThreshold: config.benbuys.approvalThreshold,
    });
    const test = { ...email, to: [arg], subject: `[TEST — ignore] ${email.subject}` };
    console.log(renderEmail(test));
    const { id } = await mailer.send(test);
    console.log(`\nSent via ${mailer.name}${id ? ` (id ${id})` : ''}.`);
    return;
  }

  throw new Error(`Unknown mode "${mode}" — use prep or email.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
