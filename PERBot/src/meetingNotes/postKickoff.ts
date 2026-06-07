import { SUBSYSTEMS, KICKOFF_MESSAGE } from './config.js';
import { postKickoffMessage, findMostRecentBotThread } from './slackHelpers.js';
import { assertExpectedETHourRange } from './timeCheck.js';

async function main(): Promise<void> {
  // Accept any Monday run between 8am-12pm ET. Cron may be delayed; the
  // idempotency check below ensures we don't post duplicate kickoffs.
  assertExpectedETHourRange(8, 12);

  const dateStr = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
  const message = KICKOFF_MESSAGE.replace('{date}', dateStr);

  // Look back 24 hours to detect existing kickoff threads (today's posts)
  const sinceUnix = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

  const results: { channel: string; status: 'ok' | 'skipped' | 'fail'; detail?: string }[] = [];

  for (const sub of SUBSYSTEMS) {
    try {
      const existing = await findMostRecentBotThread(sub.slackChannel, sinceUnix);
      if (existing) {
        console.log(`⊘ Kickoff already posted in #${sub.slackChannel} (ts=${existing}), skipping`);
        results.push({ channel: sub.slackChannel, status: 'skipped' });
        continue;
      }

      const ts = await postKickoffMessage(sub.slackChannel, message);
      console.log(`✓ Posted in #${sub.slackChannel} (ts=${ts})`);
      results.push({ channel: sub.slackChannel, status: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ Failed for #${sub.slackChannel}: ${msg}`);
      results.push({ channel: sub.slackChannel, status: 'fail', detail: msg });
    }
  }

  const posted = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failures = results.filter((r) => r.status === 'fail');

  console.log(`\nSummary: ${posted} posted, ${skipped} already existed, ${failures.length} failed.`);

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Kickoff post job crashed:', err);
  process.exit(1);
});
