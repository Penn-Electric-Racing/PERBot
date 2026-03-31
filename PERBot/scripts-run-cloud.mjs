import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const indexPath = process.env.INDEX_PATH || './data/notion-index.json';
const alwaysReindex = String(process.env.ALWAYS_REINDEX_ON_START || '').toLowerCase() === 'true';
const shouldIndex = alwaysReindex || !existsSync(path.resolve(indexPath));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function main() {
  if (shouldIndex) {
    console.log('[PERBot] Building Notion index before starting app...');
    await run('node', ['--enable-source-maps', 'dist/indexer.js']);
  } else {
    console.log('[PERBot] Existing index found. Skipping startup reindex.');
  }

  console.log('[PERBot] Starting Slack Socket Mode app...');
  await run('node', ['--enable-source-maps', 'dist/app.js']);
}

main().catch((err) => {
  console.error('[PERBot] Cloud startup failed:', err);
  process.exit(1);
});
