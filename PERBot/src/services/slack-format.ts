import type { SearchResult } from '../types.js';
import { escapeSlack } from '../utils/text.js';

function sourceLine(result: SearchResult, index: number): string {
  const historical = result.page.isHistorical ? ' • *Historical*' : '';
  return [
    `*${index + 1}. <${result.page.url}|${escapeSlack(result.page.title)}>*${historical}`,
    `_${escapeSlack(result.excerpt)}_`,
  ].join('\n');
}

export function buildResultBlocks(query: string, summary: string, results: SearchResult[]): any[] {
  const blocks: any[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*PERBot results for:* \`${escapeSlack(query)}\`` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summary },
    },
    {
      type: 'divider',
    },
  ];

  if (results.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'I could not find a strong match in the current local Notion index. Try rephrasing, adding a filter like `season:REV11`, or rebuilding the index with `npm run index`.',
      },
    });
    return blocks;
  }

  for (const [index, result] of results.entries()) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: sourceLine(result, index) },
    });
  }

  return blocks;
}
