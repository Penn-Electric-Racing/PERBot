import { draftOutreachEmail } from './emailDraft.js';
import { SponsorNotion } from './notion.js';

/**
 * CLI: `npm run draft -- "<company>" ["Sender Name"] ["inline ask"]`
 * Drafts the outreach email for one existing Bank prospect (same path as
 * `/sponsor email`, minus Slack): fills the team template, generates the fit
 * paragraph (steered by the 🎯 Specific ask toggle and/or the inline ask), writes
 * the draft toggle onto the Bank page, and prints the email. Without a sender name
 * the [NAME] placeholder is left for a human.
 */
async function main(): Promise<void> {
  const [company, senderName = '', ask = ''] = process.argv.slice(2).map((a) => a.trim());
  if (!company) {
    console.error('Usage: npm run draft -- "<company>" ["Sender Name"] ["inline ask"]');
    process.exit(1);
  }

  const notion = new SponsorNotion();
  try {
    const rows = await notion.findBankRowsByCompany(company);
    const row =
      rows.length > 1 ? rows.find((r) => r.company.toLowerCase() === company.toLowerCase()) : rows[0];
    if (!row) {
      if (rows.length > 1) {
        console.error(`\n✗  "${company}" matches several prospects — be more specific:`);
        for (const r of rows.slice(0, 8)) console.error(`   • ${r.company}  ${r.url}`);
        console.error('');
      } else {
        console.error(`\n✗  No Bank prospect matches "${company}". Add it first: npm run enrich -- "${company}"\n`);
      }
      process.exit(1);
    }

    const result = await draftOutreachEmail({ notion, row, senderName, ask });

    console.log(`\n📧  Drafted outreach for ${result.company}`);
    if (result.hasAsk) console.log(`   🎯 Includes the specific ask (specs verbatim).`);
    if (!result.grounded) {
      console.log(`   ⚠️  Homepage unreachable — paragraph uses stored research only; review closely.`);
    }
    console.log(`   Draft: ${result.draftUrl}`);
    console.log(`\n──────────────────────────────────────────────\n`);
    console.log(result.emailText);
    console.log(`\n──────────────────────────────────────────────`);
    console.log(`AI-assisted draft — review before sending.\n`);
  } catch (err) {
    console.error('\n✗  Draft failed:', err instanceof Error ? err.message : err, '\n');
    process.exit(1);
  }
}

void main();
