import { spawn } from 'node:child_process';

function spawnChild(command, args, label, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
    ...options,
  });

  child.on('error', (err) => {
    console.error(`[PERBot] ${label} failed to start:`, err);
  });

  return child;
}

async function main() {
  console.log('[PERBot] Starting Slack app...');

  const appChild = spawnChild(
    'node',
    ['--enable-source-maps', 'dist/app.js'],
    'Slack app'
  );

  appChild.on('exit', (code, signal) => {
    console.error(
      `[PERBot] Slack app exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
    );
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error('[PERBot] Cloud startup failed:', err);
  process.exit(1);
});
