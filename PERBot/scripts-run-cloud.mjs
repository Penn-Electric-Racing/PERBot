import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const indexPath = process.env.INDEX_PATH || './data/notion-index.json';
const alwaysReindex =
  String(process.env.ALWAYS_REINDEX_ON_START || '').toLowerCase() === 'true';
const shouldIndex = alwaysReindex || !existsSync(path.resolve(indexPath));

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
  console.log('[PERBot] Starting Slack app first...');

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

  if (shouldIndex) {
    console.log('[PERBot] No usable index found or forced reindex enabled.');
    console.log('[PERBot] Waiting 8 seconds, then starting background indexing...');

    setTimeout(() => {
      console.log('[PERBot] Starting Notion indexing in background...');

      const indexChild = spawnChild(
        'node',
        ['--enable-source-maps', 'dist/indexer.js'],
        'Indexer'
      );

      indexChild.on('exit', (code, signal) => {
        if (code === 0) {
          console.log('[PERBot] Background indexing finished successfully.');
        } else {
          console.error(
            `[PERBot] Background indexing failed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
          );
        }
      });
    }, 8000);
  } else {
    console.log('[PERBot] Existing index found. Skipping startup reindex.');
  }
}

main().catch((err) => {
  console.error('[PERBot] Cloud startup failed:', err);
  process.exit(1);
});
