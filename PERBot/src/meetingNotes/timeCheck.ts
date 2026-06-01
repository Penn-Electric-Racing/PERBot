/**
 * GitHub Actions cron is unreliable — runs can be delayed by hours, especially
 * on Mondays. To work around this, we schedule the workflow to fire many times
 * across a window, and use this check + idempotency in the script itself to
 * ensure only one effective run happens per scheduled occurrence.
 *
 * Manual (workflow_dispatch) runs always pass the time check so testing works.
 */
export function assertExpectedETHourRange(minHour: number, maxHour: number): void {
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

  if (etHour < minHour || etHour > maxHour) {
    console.log(`Skipping run — current ET hour is ${etHour}, expected range ${minHour}-${maxHour}.`);
    process.exit(0);
  }
}

// Backward-compatible alias (single hour = accept that hour or the next)
export function assertExpectedETHour(expectedHour: number): void {
  assertExpectedETHourRange(expectedHour, expectedHour + 1);
}
