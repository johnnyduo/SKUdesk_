import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule } from '../web/src/lib/schedule.ts';

const at = (iso: string): Date => new Date(iso);

test('a daily schedule runs at its hour, today or tomorrow', () => {
  const s = parseSchedule('0 2 * * *');
  assert.equal(s.label, 'daily 02:00 UTC');
  assert.equal(s.next(at('2026-10-17T01:30:00Z')).toISOString(), '2026-10-17T02:00:00.000Z');
  assert.equal(s.next(at('2026-10-17T02:00:00Z')).toISOString(), '2026-10-18T02:00:00.000Z');
  assert.equal(s.next(at('2026-10-17T23:59:59Z')).toISOString(), '2026-10-18T02:00:00.000Z');
});

test('an every-few-hours schedule runs on the hours that divide evenly, like cron does', () => {
  const s = parseSchedule('0 */3 * * *');
  assert.equal(s.label, 'every 3 h');
  assert.equal(s.periodMs, 3 * 3_600_000);
  assert.equal(s.next(at('2026-10-17T00:30:00Z')).toISOString(), '2026-10-17T03:00:00.000Z');
  assert.equal(s.next(at('2026-10-17T03:00:00Z')).toISOString(), '2026-10-17T06:00:00.000Z');
  assert.equal(s.next(at('2026-10-17T22:10:00Z')).toISOString(), '2026-10-18T00:00:00.000Z');
  assert.equal(parseSchedule('0 */6 * * *').next(at('2026-10-17T11:59:00Z')).toISOString(), '2026-10-17T12:00:00.000Z');
});

test('anything else reads as the daily default', () => {
  for (const bad of [undefined, null, '', 'nonsense', '*/5 * * * *', '0 */0 * * *', '0 25 * * *']) assert.equal(parseSchedule(bad as string).label, 'daily 02:00 UTC', String(bad));
});
