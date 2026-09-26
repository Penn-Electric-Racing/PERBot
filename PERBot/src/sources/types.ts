import type { DocKind, SourceKind } from '../types.js';

/**
 * What every source (Notion today, Google Drive since Phase 5) hands the indexer: one cleaned
 * document with a breadcrumb. The indexer chunks, embeds and scores from here on without caring
 * where the text came from.
 */
export interface SourceDocument {
  /** Globally unique across sources, e.g. a Notion page id or `drive:<fileId>`. */
  id: string;
  source: SourceKind;
  kind: DocKind;
  title: string;
  url: string;
  /** Ancestor titles, top-down, excluding the document itself. */
  ancestors: string[];
  cleanText: string;
  createdTime: string;
  lastEditedTime: string;
}
