/**
 * GitHub Actions cron runs in UTC and doesn't know about DST. We schedule
 * each job at TWO UTC times (one for EDT, one for EST) and have the script
 * exit early if the current Eastern-time hour isn't what we expect.
 */
export function assertExpectedETHour(expectedHour: number): void {
  const etHour = parseInt(
    new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }),
    10
  );

  if (etHour !== expectedHour) {
    console.log(`Skipping run — current ET hour is ${etHour}, expected ${expectedHour}.`);
    process.exit(0);
  }
}
