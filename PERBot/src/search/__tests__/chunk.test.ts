import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbedText, chunkMarkdown } from '../../utils/chunk.js';

const opts = { target: 300, max: 450, min: 80 };

test('splits on headings and remembers the heading path', () => {
  const md = [
    '# Introduction',
    'The PCM is the brain of the car. '.repeat(6),
    '## What is the PCM?',
    'It translates pedal inputs into torque requests. '.repeat(6),
    '## Torque security',
    'It must check readings are consistent. '.repeat(6),
  ].join('\n');
  const chunks = chunkMarkdown(md, opts);
  assert.ok(chunks.length >= 3, `got ${chunks.length}`);
  assert.equal(chunks[0]!.heading, 'Introduction');
  assert.equal(chunks[1]!.heading, 'Introduction › What is the PCM?');
  assert.equal(chunks[2]!.heading, 'Introduction › Torque security');
  for (const c of chunks) assert.ok(c.text.length <= opts.max + 1, `chunk too long: ${c.text.length}`);
});

test('small sections merge instead of becoming crumbs', () => {
  const md = '# A\nshort\n# B\nalso short\n# C\ntiny';
  const chunks = chunkMarkdown(md, opts);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.text.includes('# C'));
});

test('long lines are split at sentence boundaries, never mid-word', () => {
  const md = 'Sentence one is here. '.repeat(60);
  const chunks = chunkMarkdown(md, opts);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.text.length <= opts.max);
    assert.ok(/\.$/.test(c.text.trim()), c.text.slice(-20));
  }
});

test('code fences are not split on # lines', () => {
  const md = '```sh\n# comment inside code\necho hi\n```\n# Real heading\ntext';
  const chunks = chunkMarkdown(md, opts);
  assert.equal(chunks[0]!.heading, null);
  assert.ok(chunks[chunks.length - 1]!.text.includes('# Real heading'));
});

test('embed text carries title, breadcrumb and heading', () => {
  const s = buildEmbedText('REV11 PCM Documentation', ['Electrical', 'PCM'], 'Intro › What', 'body');
  assert.equal(s, 'REV11 PCM Documentation\nElectrical › PCM\nIntro › What\n\nbody');
  assert.equal(buildEmbedText('T', [], null, 'b'), 'T\n\nb');
});
