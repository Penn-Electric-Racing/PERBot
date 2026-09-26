import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanNotionMarkdown, extractDocDate, extractRevNumber, isTemplatePlaceholder } from '../../utils/notionText.js';

const S3 =
  'https://prod-files-secure.s3.us-west-2.amazonaws.com/69f38b25/abc/Screenshot.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef&X-Amz-SignedHeaders=host&x-id=GetObject';

test('drops signed image URLs but keeps captions', () => {
  const out = cleanNotionMarkdown(`Intro\n![High level overview of the PCM](${S3})\n![](${S3})\nAfter`);
  assert.ok(!out.includes('X-Amz'), out);
  assert.ok(out.includes('[Image: High level overview of the PCM]'));
  assert.ok(out.includes('After'));
});

test('unwraps columns, callouts, toggles and drops empty blocks + attribute suffixes', () => {
  const md = [
    '<table_of_contents color="gray"/>',
    '# Assembly procedure {toggle="true"}',
    '<columns>',
    '\t<column ratio="50">',
    '\t\tThe PCM Box is a tightly integrated package.',
    '\t\t<empty-block/>',
    '\t</column>',
    '</columns>',
    '<callout icon="⚠️" color="yellow_bg">',
    '\tGenerated files are **not saved to Git**.',
    '</callout>',
    '<details>',
    '<summary>Pages</summary>',
    '\t<page url="https://app.notion.com/p/abc">Board Architecture</page>',
    '</details>',
  ].join('\n');
  const out = cleanNotionMarkdown(md);
  assert.equal(out.includes('<'), false, out);
  assert.ok(out.includes('# Assembly procedure'));
  assert.ok(!out.includes('toggle='));
  assert.ok(out.includes('The PCM Box is a tightly integrated package.'));
  assert.ok(out.includes('**not saved to Git**'));
  assert.ok(out.includes('**Pages**'));
  assert.ok(out.includes('Board Architecture'));
});

test('tables become pipe rows and mentions become text', () => {
  const md =
    '<table header-row="true"><colgroup><col width="1"/></colgroup>' +
    '<tr><td>Page</td><td>What is in it</td></tr>' +
    '<tr><td><mention-page url="https://app.notion.com/p/x">FreeRTOS</mention-page></td><td>Tasks and the 1 ms tick</td></tr></table>\n' +
    'Due <mention-date start="2019-02-09"/> by <mention-user url="user://abc"/>. See <database url="x">Ops Tasks</database>.';
  const out = cleanNotionMarkdown(md);
  assert.ok(out.includes('Page | What is in it'));
  assert.ok(out.includes('FreeRTOS | Tasks and the 1 ms tick'));
  assert.ok(out.includes('Due 2019-02-09 by .'));
  assert.ok(out.includes('Database: Ops Tasks'));
});

test('leaves code fences alone', () => {
  const md = 'Before\n```cpp\n#include <stdint.h>\nstd::vector<Box<T>> x; // {color="gray"}\n```\n<span underline="true">after</span>';
  const out = cleanNotionMarkdown(md);
  assert.ok(out.includes('#include <stdint.h>'));
  assert.ok(out.includes('std::vector<Box<T>> x; // {color="gray"}'));
  assert.ok(out.endsWith('after'));
});

test('unescapes Notion-escaped punctuation', () => {
  assert.equal(cleanNotionMarkdown('Shirt sale \\$10 \\[TODO\\]'), 'Shirt sale $10 [TODO]');
});

test('template placeholders are detected', () => {
  const t = '## Summary\nProvide a brief summary of the issue.\n## Details\nDescribe the issue in detail, including any relevant background information.';
  assert.equal(isTemplatePlaceholder(t), true);
  assert.equal(isTemplatePlaceholder(`${t}\n${'real content '.repeat(80)}`), false);
});

test('rev numbers and dates from titles', () => {
  assert.equal(extractRevNumber('REV11 PCM Documentation'), 11);
  assert.equal(extractRevNumber('Rev 9 LUDWIG'), 9);
  assert.equal(extractRevNumber("Lauren's Rev8 Reflection"), 8);
  assert.equal(extractRevNumber('Cooling', 'Mechanical › REV12 › Cooling'), 12);
  assert.equal(extractRevNumber('nothing here'), null);
  assert.equal(extractDocDate('2018-09-04 Weekly Update'), '2018-09-04');
  assert.equal(extractDocDate('REVX Updates - 02/12/2025'), '2025-02-12');
  assert.equal(extractDocDate('9SLASH25SLASH19 Mech Updates'), '2019-09-25');
  assert.equal(extractDocDate('4/15/26 Mech Meeting Notes'), '2026-04-15');
  assert.equal(extractDocDate('July 13, 2022 REV8 Weekly Update'), '2022-07-13');
  assert.equal(extractDocDate('11/5 Mechanical Meeting'), null);
});
