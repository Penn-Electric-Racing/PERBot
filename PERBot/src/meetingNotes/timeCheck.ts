/**
 * GitHub Actions cron runs in UTC and is often delayed by 15-60 minutes.
 * For automatic (cron) runs we accept the expected hour or the hour after.
 * For manual (workflow_dispatch) runs we skip the check entirely so testing
 * works at any time.
 */
export function assertExpectedETHour(expectedHour: number): void {
  // Manual runs from the Actions tab set this env var to 'workflow_dispatch'
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    console.log('Manual run detected — skipping time check.');
    return;
  }

  const etHour = parseInt(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }),
    10
  );

  // Accept the expected hour or the hour after (for late cron runs)
  if (etHour !== expectedHour && etHour !== expectedHour + 1) {
    console.log(`Skipping run — current ET hour is ${etHour}, expected ${expectedHour} or ${expectedHour + 1}.`);
    process.exit(0);
  }
}
