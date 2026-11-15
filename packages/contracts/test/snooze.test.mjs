import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SNOOZE_MAX_DAYS, snoozeOptions } from '../dist/snooze.js'

const of = (now) => Object.fromEntries(snoozeOptions(now).map((o) => [o.key, o.until]))

test('snooze choices land where the menu says, in local time', () => {
  // A Wednesday, late in the evening.
  const now = new Date(2026, 10, 18, 23, 30)
  const o = of(now)
  assert.equal(o['1h'].getTime(), now.getTime() + 3_600_000)
  assert.equal(o['3h'].getTime(), now.getTime() + 3 * 3_600_000)
  assert.deepEqual(o.tomorrow, new Date(2026, 10, 19, 9))
  assert.deepEqual(o['next-week'], new Date(2026, 10, 23, 9))
  assert.deepEqual(o.month, new Date(2026, 11, 18, 23, 30))
})

test('next week from a Monday is the Monday after; a month from the 31st is the last day', () => {
  assert.deepEqual(of(new Date(2026, 10, 16, 8))['next-week'], new Date(2026, 10, 23, 9))
  assert.deepEqual(of(new Date(2027, 0, 31, 10)).month, new Date(2027, 1, 28, 10))
  assert.deepEqual(of(new Date(2026, 11, 15, 10)).month, new Date(2027, 0, 15, 10))
})

test('every choice is in the future and within what the API takes', () => {
  for (const now of [new Date(2026, 0, 31, 23, 59), new Date(2026, 6, 31, 0, 1)])
    for (const o of snoozeOptions(now)) {
      const ms = o.until.getTime() - now.getTime()
      assert.ok(ms > 0 && ms <= SNOOZE_MAX_DAYS * 86_400_000, o.key)
    }
})
