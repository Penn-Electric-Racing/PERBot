import { Client } from '@notionhq/client';
import { ParsedUpdate } from './parseUpdates';
import { NOTION_PARENT_PAGE_ID } from './config';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

export interface SubsystemContent {
  subsystem: string;
  updates: ParsedUpdate;
  threadLink: string | null;
  imageCount: number;
}

export async function createMeetingNotesPage(
  date: Date,
  subsystemContents: SubsystemContent[]
): Promise<string> {
  // Format: "5/24" — Notion title convention used historically
  const month = date.toLocaleString('en-US', { month: 'numeric', timeZone: 'America/New_York' });
  const day = date.toLocaleString('en-US', { day: 'numeric', timeZone: 'America/New_York' });
  const title = `${month}/${day} Mechanical Meeting`;

  const children = buildPageBlocks(subsystemContents);

  const result = await notion.pages.create({
    parent: { page_id: NOTION_PARENT_PAGE_ID },
    properties: {
      title: { title: [{ text: { content: title } }] },
    },
    children,
  });

  return (result as { url: string }).url;
}

function buildPageBlocks(contents: SubsystemContent[]): any[] {
  const blocks: any[] = [];

  // Top: General Updates section (left empty — subteam leads fill in manually morning of meeting)
  blocks.push(h1('General Updates/Announcements'));
  blocks.push(numberedListItem(''));

  for (const { subsystem, updates, threadLink, imageCount } of contents) {
    blocks.push(h1(subsystem));

    // 3-column block: Deadlines | Complete | Incomplete
    blocks.push(
      columnList([
        [h2('Deadlines'), ...parseLines(updates.deadlines)],
        [boldParagraph('Complete'), ...parseLines(updates.complete)],
        [boldParagraph('Incomplete'), ...parseLines(updates.incomplete)],
      ])
    );

    blocks.push(h2('Logistical Updates'));
    blocks.push(...parseBullets(updates.logisticalUpdates));

    blocks.push(h2('Design Updates (design issues, PDR feedback, CAD updates/screenshots, etc.)'));
    blocks.push(...parseBullets(updates.designUpdates));

    blocks.push(h2('Manufacturing Updates'));
    blocks.push(...parseBullets(updates.manufacturingUpdates));

    blocks.push(h2('Overdue Items + Catchup Plan'));
    blocks.push(...parseBullets(updates.overdueItems));

    blocks.push(h2('14-day Look-Ahead Overview'));
    blocks.push(...parseBullets(updates.lookAhead));

    // Slack thread link — always include so people can verify source
    if (threadLink) {
      if (imageCount > 0) {
        blocks.push(
          paragraphWithLink(`📷 ${imageCount} image(s) posted in thread — `, 'view in Slack', threadLink)
        );
      } else {
        blocks.push(paragraphWithLink('💬 ', 'View source thread in Slack', threadLink));
      }
    } else {
      blocks.push(italicParagraph('⚠️ No update thread found for this subsystem this week'));
    }
  }

  return blocks;
}

// --- Notion block helpers -----------------------------------------------------

function h1(text: string) {
  return {
    object: 'block',
    type: 'heading_1',
    heading_1: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function h2(text: string) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function boldParagraph(text: string) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: text },
          annotations: { bold: true },
        },
      ],
    },
  };
}

function italicParagraph(text: string) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: text },
          annotations: { italic: true, color: 'gray' },
        },
      ],
    },
  };
}

function paragraph(text: string) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: text ? [{ type: 'text', text: { content: text } }] : [] },
  };
}

function paragraphWithLink(prefix: string, linkText: string, url: string) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content: prefix } },
        { type: 'text', text: { content: linkText, link: { url } } },
      ],
    },
  };
}

function bulletItem(text: string) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function numberedListItem(text: string) {
  return {
    object: 'block',
    type: 'numbered_list_item',
    numbered_list_item: { rich_text: text ? [{ type: 'text', text: { content: text } }] : [] },
  };
}

function columnList(columns: any[][]) {
  return {
    object: 'block',
    type: 'column_list',
    column_list: {
      children: columns.map((blocksInColumn) => ({
        object: 'block',
        type: 'column',
        column: {
          // Notion requires at least one child block per column
          children: blocksInColumn.length > 0 ? blocksInColumn : [paragraph('')],
        },
      })),
    },
  };
}

/**
 * Parse content that should become bulleted list items. Lines that already
 * start with "- " or "* " are treated as bullets; anything else is wrapped.
 * Empty input → a single empty paragraph (Notion needs something there).
 */
function parseBullets(text: string): any[] {
  if (!text.trim()) return [paragraph('')];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((line) => bulletItem(line.replace(/^[-*]\s*/, '')));
}

/**
 * Parse content for the Deadlines/Complete/Incomplete columns — each line
 * becomes a plain bullet without preserving leading dashes.
 */
function parseLines(text: string): any[] {
  if (!text.trim()) return [];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => bulletItem(line.replace(/^[-*]\s*/, '')));
}
