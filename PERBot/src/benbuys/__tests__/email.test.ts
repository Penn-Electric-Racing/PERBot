import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequisitionEmail, renderEmail } from '../email.js';
import { toRfc822, GmailApiMailer, WebhookMailer } from '../mailer.js';
import { testAdapter } from './helpers.js';

const base = { from: 'electric@engineering.upenn.edu', cc: ['oat@engineering.upenn.edu', 'arjunsh@sas.upenn.edu'], approvalThreshold: 500 };

test('email ≤ $500: NO APPROVAL subject, no approval question', () => {
  const email = buildRequisitionEmail(testAdapter, { ...base, requisitionNumber: '4321745', total: 402.02, lineCount: 17 });
  assert.equal(email.subject, '[NO APPROVAL REQUIRED] PER Requisition 4321745');
  assert.equal(email.approvalRequired, false);
  assert.deepEqual(email.to, ['purchasing@engineering.upenn.edu']);
  assert.equal(
    email.body,
    'Hi,\n\nI just placed Requisition 4321745 on BenBuys for a DigiKey order for electrical, and the order total is $402.02 (17 line items). Thank you for placing the order!\n\nBest,\nKatherine Shen'
  );
});

test('email > $500: APPROVAL REQUIRED subject and the Dr. Tertuliano question before the thank-you', () => {
  const email = buildRequisitionEmail(testAdapter, { ...base, requisitionNumber: '4321746', total: 1234.5, lineCount: 1 });
  assert.equal(email.subject, '[APPROVAL REQUIRED] PER Requisition 4321746');
  assert.equal(email.approvalRequired, true);
  assert.match(email.body, /order total is \$1,234\.50 \(1 line item\)\. Dr\. Tertuliano, do you approve\? Thank you for placing the order!/);
});

test('exactly $500 is not approval-required', () => {
  assert.equal(buildRequisitionEmail(testAdapter, { ...base, requisitionNumber: '123456', total: 500, lineCount: 2 }).approvalRequired, false);
});

test('renderEmail / toRfc822 carry From, To, Cc, Subject', () => {
  const email = buildRequisitionEmail(testAdapter, { ...base, requisitionNumber: '4321745', total: 10, lineCount: 1 });
  const rendered = renderEmail(email);
  assert.match(rendered, /^From: electric@engineering\.upenn\.edu\nTo: purchasing@engineering\.upenn\.edu\nCc: oat@engineering\.upenn\.edu, arjunsh@sas\.upenn\.edu\nSubject: \[NO APPROVAL REQUIRED\] PER Requisition 4321745\n\nHi,/);
  const raw = toRfc822(email);
  assert.match(raw, /^From: electric@engineering\.upenn\.edu\r\nTo: purchasing@engineering\.upenn\.edu\r\nCc: oat@engineering\.upenn\.edu, arjunsh@sas\.upenn\.edu\r\nSubject: \[NO APPROVAL REQUIRED\] PER Requisition 4321745\r\nMIME-Version: 1\.0\r\n/);
  assert.match(raw, /\r\n\r\nHi,\r\n\r\nI just placed/);
});

test('GmailApiMailer: refreshes the token, then posts a base64url raw message', async () => {
  const calls: { url: string; init: any }[] = [];
  const fetchFn: any = async (url: string, init: any) => {
    calls.push({ url, init });
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    return new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 });
  };
  const mailer = new GmailApiMailer({ clientId: 'id', clientSecret: 'sec', refreshToken: 'rt' }, fetchFn);
  const email = buildRequisitionEmail(testAdapter, { ...base, requisitionNumber: '4321745', total: 10, lineCount: 1 });
  const { id } = await mailer.send(email);
  assert.equal(id, 'msg-1');
  assert.equal(calls.length, 2);
  assert.equal(String(calls[0]!.init.body), 'client_id=id&client_secret=sec&refresh_token=rt&grant_type=refresh_token');
  assert.equal(calls[1]!.init.headers.Authorization, 'Bearer tok');
  const raw = JSON.parse(calls[1]!.init.body).raw as string;
  assert.doesNotMatch(raw, /[+/=]/);
  assert.equal(Buffer.from(raw, 'base64url').toString('utf8'), toRfc822(email));
});

test('GmailApiMailer: a failed token refresh throws before any send', async () => {
  let sends = 0;
  const fetchFn: any = async (url: string) => {
    if (url.includes('oauth2')) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 });
    sends += 1;
    return new Response('{}', { status: 200 });
  };
  const mailer = new GmailApiMailer({ clientId: 'id', clientSecret: 'sec', refreshToken: 'rt' }, fetchFn);
  const email = buildRequisitionEmail(testAdapter, { ...base, requisitionNumber: '4321745', total: 10, lineCount: 1 });
  await assert.rejects(() => mailer.send(email), /invalid_grant.*expired or revoked/);
  assert.equal(sends, 0);
});

test('WebhookMailer: posts the flat JSON shape and surfaces non-2xx', async () => {
  const seen: any[] = [];
  const ok: any = async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    return new Response('', { status: 202 });
  };
  const email = buildRequisitionEmail(testAdapter, { ...base, requisitionNumber: '4321745', total: 10, lineCount: 1 });
  await new WebhookMailer('https://example.test/flow', ok).send(email);
  assert.deepEqual(Object.keys(seen[0]), ['from', 'to', 'cc', 'subject', 'body']);
  assert.equal(seen[0].cc, 'oat@engineering.upenn.edu;arjunsh@sas.upenn.edu');
  const bad: any = async () => new Response('nope', { status: 500 });
  await assert.rejects(() => new WebhookMailer('https://example.test/flow', bad).send(email), /Email webhook failed: 500 nope/);
});
