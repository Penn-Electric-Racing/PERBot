import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEATMAP_AS_OF, HEATMAP_URL, heatmapText } from '../slack.js';

test('heatmapText: links the hosted page and says how old the data is', () => {
  const text = heatmapText();
  assert.ok(text.includes(`<${HEATMAP_URL}|Sponsor heatmap>`));
  assert.ok(text.includes(HEATMAP_AS_OF));
});
