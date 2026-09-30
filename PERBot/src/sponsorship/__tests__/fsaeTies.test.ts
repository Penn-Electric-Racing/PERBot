import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSnippets, findTeamPageLinks, formatFsaeEvidence, verifyLabels } from '../fsaeTies.js';
import { compareForRank, SponsorScores } from '../scoring.js';

const BIO =
  'Our Leadership. Jane Doe, CTO. Jane joined Acme in 2019 after leading the powertrain group ' +
  "of Purdue's Formula SAE team for three seasons. Bob Roe, CEO, previously ran sales at Initech.";

test('findTeamPageLinks keeps same-site team pages, best first', () => {
  const html = `
    <a href="/about">About</a>
    <a href="https://www.acme.com/company/leadership">Leadership</a>
    <a href="/products">Products</a>
    <a href="https://other.com/team">Partner team</a>
    <a href="/careers">Careers</a>
    <a href="/brochure-team.pdf">Team PDF</a>`;
  const links = findTeamPageLinks(html, 'https://acme.com');
  assert.equal(links[0], 'https://www.acme.com/company/leadership');
  assert.ok(links.includes('https://acme.com/about'));
  assert.ok(!links.some((l) => l.includes('other.com') || l.includes('products') || l.endsWith('.pdf')));
  assert.equal(links.at(-1), 'https://acme.com/careers');
});

test('extractSnippets windows each FSAE mention and ignores Formula E', () => {
  assert.equal(extractSnippets('We sponsor a Formula E team and F1.', 'u').length, 0);
  const snips = extractSnippets(BIO, 'https://acme.com/team');
  assert.equal(snips.length, 1);
  assert.match(snips[0]!.text, /Jane Doe/);
  // Two mentions close together merge into one window.
  assert.equal(extractSnippets('FSAE alum and Formula Student judge', 'u').length, 1);
});

test('verifyLabels keeps only quotes and names that appear verbatim', () => {
  const snippets = [{ url: 'https://acme.com/team', text: BIO }];
  const { people, companyMentions } = verifyLabels(snippets, [
    { snippet: 0, kind: 'person', person: 'Jane Doe', quote: "leading the powertrain group of Purdue's Formula SAE team" },
    // invented name
    { snippet: 0, kind: 'person', person: 'John Smith', quote: "Purdue's Formula SAE team" },
    // paraphrased quote
    { snippet: 0, kind: 'person', person: 'Bob Roe', quote: 'Bob raced FSAE at MIT' },
    // quote without an FSAE term
    { snippet: 0, kind: 'company', quote: 'previously ran sales at Initech' },
    // out-of-range snippet index
    { snippet: 3, kind: 'company', quote: 'Formula SAE' },
  ]);
  assert.deepEqual(people.map((p) => p.name), ['Jane Doe']);
  assert.equal(companyMentions.length, 0);
});

test('verifyLabels keeps a verified champion name on a company mention', () => {
  const text = 'Torsten also initiated our program, donating over 1,000 devices to student racing teams such as Formula SAE.';
  const { people, companyMentions } = verifyLabels([{ url: 'u', text }], [
    { snippet: 0, kind: 'company', person: 'Torsten', quote: 'donating over 1,000 devices to student racing teams such as Formula SAE' },
  ]);
  assert.equal(people.length, 0);
  assert.equal(companyMentions[0]?.champion, 'Torsten');
  assert.match(formatFsaeEvidence({ ties: false, people, companyMentions, pagesScanned: ['u'] }), /champion: Torsten/);
});

test('formatFsaeEvidence names people and stays under the Notion limit', () => {
  const text = formatFsaeEvidence({
    ties: true,
    people: [{ name: 'Jane Doe', quote: 'x'.repeat(3000), url: 'u' }],
    companyMentions: [],
    pagesScanned: ['u'],
  });
  assert.ok(text.startsWith('🏁 Jane Doe'));
  assert.ok(text.length <= 2000);
  assert.match(formatFsaeEvidence({ ties: false, people: [], companyMentions: [], pagesScanned: ['a', 'b'] }), /2 page/);
});

test('compareForRank puts FSAE ties above a higher Priority', () => {
  const hi: SponsorScores = { contactStrength: 3, marketFit: 3, sponsorsOtherTeams: 3, valueBand: 3, categoryNeed: 3 };
  const lo: SponsorScores = { contactStrength: 0, marketFit: 1, sponsorsOtherTeams: 0, valueBand: 1, categoryNeed: 0 };
  const rows = [
    { name: 'big', fsaeTies: false, scores: hi },
    { name: 'alum-lo', fsaeTies: true, scores: lo },
    { name: 'alum-hi', fsaeTies: true, scores: hi },
  ];
  assert.deepEqual([...rows].sort(compareForRank).map((r) => r.name), ['alum-hi', 'alum-lo', 'big']);
});
