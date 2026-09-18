import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMeeting, saturdayOnOrAfter } from '../meetings.js';

test('saturdayOnOrAfter: weekdays roll forward, Saturday stays put', () => {
  assert.equal(saturdayOnOrAfter('2026-09-13'), '2026-09-19'); // Sunday
  assert.equal(saturdayOnOrAfter('2026-09-14'), '2026-09-19'); // Monday
  assert.equal(saturdayOnOrAfter('2026-09-18'), '2026-09-19'); // Friday
  assert.equal(saturdayOnOrAfter('2026-09-19'), '2026-09-19'); // Saturday
  assert.equal(saturdayOnOrAfter('2026-09-19T21:30:00.000Z'), '2026-09-19'); // datetime tolerated
});

const meetings = [
  { id: 'm0919', date: '2026-09-19' },
  { id: 'm0912', date: '2026-09-12' },
  { id: 'm0829', date: '2026-08-29' },
];

test('pickMeeting: a mid-week task belongs to the coming Saturday', () => {
  assert.equal(pickMeeting(meetings, '2026-09-14')?.id, 'm0919');
  assert.equal(pickMeeting(meetings, '2026-09-13')?.id, 'm0919');
});

test('pickMeeting: a task dated on the Saturday belongs to that meeting', () => {
  assert.equal(pickMeeting(meetings, '2026-09-12')?.id, 'm0912');
  assert.equal(pickMeeting(meetings, '2026-09-19')?.id, 'm0919');
});

test('pickMeeting: never links to a past meeting or a later week', () => {
  assert.equal(pickMeeting(meetings, '2026-09-20'), null); // Sunday after the last page
  assert.equal(pickMeeting(meetings, '2026-09-05'), null); // week with no page (9/5 skipped)
  assert.equal(pickMeeting([], '2026-09-14'), null);
});

test('pickMeeting: tolerates a meeting dated before Saturday in the same week', () => {
  const odd = [{ id: 'thu', date: '2026-09-17' }, { id: 'sat', date: '2026-09-19' }];
  assert.equal(pickMeeting(odd, '2026-09-14')?.id, 'thu');
  assert.equal(pickMeeting(odd, '2026-09-18')?.id, 'sat');
});
