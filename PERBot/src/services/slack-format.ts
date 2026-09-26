import type { SearchResult } from '../types.js';
import { escapeSlack } from '../utils/text.js';

function sourceLine(result: SearchResult, index: number): string {
  const { page } = result;
  const tags: string[] = [];
  if (page.revNumber) tags.push(`REV${page.revNumber}`);
  if (page.isHistorical) tags.push('*Historical*');
  if (page.source === 'drive') tags.push(':open_file_folder: Drive');
  const crumbs = page.path.slice(0, -1).join(' › ');
  const meta = [crumbs ? `_${escapeSlack(crumbs)}_` : '', ...tags].filter(Boolean).join(' • ');
  return [
    `*${index + 1}. <${page.url}|${escapeSlack(page.title)}>*${meta ? `  ${meta}` : ''}`,
    result.excerpt ? `> ${escapeSlack(result.excerpt)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface ResultMeta {
  weak?: boolean;
  indexedPages?: number;
  generatedAt?: string;
}

export function buildResultBlocks(query: string, summary: string, results: SearchResult[], meta: ResultMeta = {}): any[] {
  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*PERBot results for:* \`${escapeSlack(query)}\`` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summary.slice(0, 2900) },
    },
    { type: 'divider' },
  ];

  if (results.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'No matching pages in the indexed docs. Try different words, an acronym spelled out, or a filter like `rev:11`.',
      },
    });
    return blocks;
  }

  if (meta.weak) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: ':thinking_face: Weak match — these are the closest pages, but they may not cover the question.' }],
    });
  }

  for (const [index, result] of results.entries()) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: sourceLine(result, index).slice(0, 2900) } });
  }

  const footer: string[] = [];
  if (meta.indexedPages) footer.push(`${meta.indexedPages.toLocaleString()} pages indexed`);
  if (meta.generatedAt) footer.push(`index from ${meta.generatedAt.slice(0, 10)}`);
  footer.push('`/dt <question>` · `rev:11` · `subsystem:pcm` · `historical:true`');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer.join(' · ') }] });

  return blocks;
}
