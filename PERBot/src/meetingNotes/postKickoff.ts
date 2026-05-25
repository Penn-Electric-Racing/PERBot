import { SUBSYSTEMS, KICKOFF_MESSAGE } from './config';
import { postKickoffMessage } from './slackHelpers';
import { assertExpectedETHour } from './timeCheck';

async function main(): Promise<void> {
  assertExpectedETHour(9);

  const dateStr = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
  const message = KICKOFF_MESSAGE.replace('{date}', dateStr);

  const results: { channel: string; status: 'ok' | 'fail'; detail?: string }[] = [];

  for (const sub of SUBSYSTEMS) {
    try {
      const ts = await postKickoffMessage(sub.slackChannel, message);
      console.log(`✓ Posted in #${sub.slackChannel} (ts=${ts})`);
      results.push({ channel: sub.slackChannel, status: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ Failed for #${sub.slackChannel}: ${msg}`);
      results.push({ channel: sub.slackChannel, status: 'fail', detail: msg });
    }
  }

  const failures = results.filter((r) => r.status === 'fail');
  if (failures.length > 0) {
    console.error(`Kickoff posted with ${failures.length} failure(s).`);
    process.exit(1);
  }
  console.log(`Kickoff posted in all ${results.length} channels.`);
}

main().catch((err) => {
  console.error('Kickoff post job crashed:', err);
  process.exit(1);
});
