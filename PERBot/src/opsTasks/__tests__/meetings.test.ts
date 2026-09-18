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

test('pickMeeting: a page stamped with its Sunday creation time still counts for that week', () => {
  const sundayStamped = [{ id: 'm0919', date: '2026-09-19' }, { id: 'm0926', date: '2026-09-20T13:00:00.000Z' }];
  assert.equal(pickMeeting(sundayStamped, '2026-09-21')?.id, 'm0926'); // Monday → the page created Sunday
  assert.equal(pickMeeting(sundayStamped, '2026-09-26')?.id, 'm0926'); // the Saturday itself
  assert.equal(pickMeeting(sundayStamped, '2026-09-19')?.id, 'm0919'); // previous week unaffected
  assert.equal(pickMeeting(sundayStamped, '2026-09-27'), null); // following week has no page yet
});

test('pickMeeting: a Thursday-stamped page (old repeat schedule) maps to its Saturday', () => {
  const odd = [{ id: 'thu', date: '2026-09-17' }];
  assert.equal(pickMeeting(odd, '2026-09-14')?.id, 'thu');
  assert.equal(pickMeeting(odd, '2026-09-19')?.id, 'thu');
});
