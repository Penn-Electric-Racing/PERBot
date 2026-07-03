import { enrichCompany, DomainResolutionError } from './enrichCompany.js';

/**
 * CLI: `npm run enrich -- "<company or url>"`
 * Runs the enrichment pipeline for one company and prints a summary. Env is loaded
 * transitively via config.ts (dotenv). Useful for seeding the Bank and for testing
 * the pipeline without Slack.
 */
async function main(): Promise<void> {
  const input = process.argv.slice(2).join(' ').trim();
  if (!input) {
    console.error('Usage: npm run enrich -- "<company or url>"');
    process.exit(1);
  }

  try {
    const result = await enrichCompany(input);

    if (result.deduped) {
      console.log(`\n↩︎  Already in the Bank — skipped.`);
      console.log(`   Company: ${result.company}`);
      console.log(`   Domain:  ${result.domain}`);
      console.log(`   Row:     ${result.bankPageUrl}\n`);
      return;
    }

    const c = result.classification;
    const contact = result.contact
      ? `${result.contact.name || '(no name)'} <${result.contact.email}> ` +
        `— ${result.contact.verificationStatus}, confidence ${result.contact.confidence}`
      : '(none found)';

    console.log(`\n✅  Added to the Prospect Bank`);
    console.log(`   Company:  ${result.company}`);
    console.log(`   Domain:   ${result.domain}`);
    console.log(`   Type:     ${c.type}   Channel: ${c.channel}`);
    console.log(`   Category: ${c.categories.join(', ')}`);
    console.log(`   Scores:   market ${c.marketFit}/3 · value ${c.valueBand}/3 · need ${c.categoryNeed}/3 (AI) — set Contact strength + Sponsors other teams in Notion`);
    console.log(`   Fit:      ${c.fitReason}`);
    console.log(`   Angle:    ${c.suggestedAngle || '(none)'}`);
    console.log(`   Contact:  ${contact}`);
    if (result.needsReview) console.log(`   ⚠️  Needs review: ${result.reviewReason}`);
    console.log(`   Row:      ${result.bankPageUrl}\n`);
  } catch (err) {
    if (err instanceof DomainResolutionError) {
      console.error(`\n✗  ${err.message}\n`);
    } else {
      console.error('\n✗  Enrichment failed:', err instanceof Error ? err.message : err, '\n');
    }
    process.exit(1);
  }
}

void main();
