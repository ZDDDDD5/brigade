import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addDays,
  dayIndex,
  laneOut,
  movableOf,
  movedCron,
  runsBetween,
  slotCron,
  weekStart,
} from '../lib/routine-calendar'

// The week of Monday 16 November 2026, in the browser's own timezone.
const monday = new Date(2026, 10, 16)
const sunday = new Date(2026, 10, 22, 23, 59)

test('a week starts on Monday at midnight, and its days count from 0', () => {
  assert.deepEqual(weekStart(new Date(2026, 10, 19, 15, 30)), monday)
  assert.deepEqual(weekStart(sunday), monday)
  assert.deepEqual(weekStart(monday), monday)
  assert.equal(dayIndex(new Date(2026, 10, 19, 23, 0), monday), 3)
  assert.equal(dayIndex(sunday, monday), 6)
  assert.equal(dayIndex(new Date(2026, 10, 23, 0, 1), monday), 7)
})

test('a week runs Monday to Sunday across a DST change', () => {
  // Europe moves its clocks back on Sunday 25 October 2026.
  const start = weekStart(new Date(2026, 9, 25, 12))
  assert.deepEqual(start, new Date(2026, 9, 19))
  assert.equal(dayIndex(new Date(2026, 9, 25, 23), start), 6)
  assert.deepEqual(addDays(start, 7), new Date(2026, 9, 26))
})

test('runs in the week, and routines too frequent to draw at their times', () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const end = addDays(monday, 7)
  const weekdays = runsBetween('0 9 * * 1-5', tz, monday, end)
  assert.equal(weekdays.runs.length, 5)
  assert.equal(weekdays.frequent, false)
  assert.deepEqual(weekdays.runs[0], new Date(2026, 10, 16, 9))

  assert.equal(runsBetween('0 8,12,18 * * *', tz, monday, end).frequent, false)
  assert.equal(runsBetween('15 * * * *', tz, monday, end).frequent, true)
  assert.equal(runsBetween('*/5 * * * *', tz, monday, end).frequent, true)
  assert.equal(runsBetween('0 10 1 * *', tz, monday, end).runs.length, 0)
  assert.deepEqual(runsBetween('not a cron', tz, monday, end), { runs: [], frequent: false })
})

test('only the rhythms the dialog writes can be dragged', () => {
  assert.deepEqual(movableOf('0 9 * * *'), { kind: 'daily', hour: 9, minute: 0 })
  assert.deepEqual(movableOf('30 7 * * 1-5'), { kind: 'weekdays', hour: 7, minute: 30 })
  assert.deepEqual(movableOf('0 16 * * 5'), { kind: 'weekly', hour: 16, minute: 0, day: 5 })
  assert.equal(movableOf('15 * * * *'), null)
  assert.equal(movableOf('30 11 * * 1,3'), null)
  assert.equal(movableOf('0 10 1 * *'), null)
  assert.equal(movableOf('0 25 * * *'), null)
})

test('a dropped run writes the cron in the schedule’s own timezone', () => {
  // 15:45 UTC on Thursday 19 November is 16:45 in Paris and 10:45 in New York.
  const at = new Date('2026-11-19T15:45:00Z')
  assert.equal(
    movedCron({ kind: 'weekly', hour: 9, minute: 0, day: 1 }, at, 'Europe/Paris'),
    '45 16 * * 4',
  )
  assert.equal(
    movedCron({ kind: 'daily', hour: 9, minute: 0 }, at, 'America/New_York'),
    '45 10 * * *',
  )
  assert.equal(movedCron({ kind: 'weekdays', hour: 9, minute: 0 }, at, 'UTC'), '45 15 * * 1-5')
  // Late at night in UTC is already the next day in Tokyo: a weekly one moves there.
  const late = new Date('2026-11-19T23:30:00Z')
  assert.equal(
    movedCron({ kind: 'weekly', hour: 9, minute: 0, day: 4 }, late, 'Asia/Tokyo'),
    '30 8 * * 5',
  )
  assert.equal(
    movedCron(
      { kind: 'weekly', hour: 0, minute: 0, day: 4 },
      new Date('2026-11-19T00:05:00Z'),
      'UTC',
    ),
    '5 0 * * 4',
  )
})

test('a new routine from a slot runs weekly at that time', () => {
  assert.equal(slotCron(new Date(2026, 10, 17, 15, 30)), '30 15 * * 2')
  assert.equal(slotCron(new Date(2026, 10, 22, 0, 0)), '0 0 * * 0')
})

test('overlapping blocks share the width; others take it all', () => {
  const placed = laneOut(
    [
      { id: 'c', minute: 570 },
      { id: 'a', minute: 540 },
      { id: 'b', minute: 540 },
      { id: 'e', minute: 590 },
      { id: 'd', minute: 900 },
    ],
    45,
  )
  const by = Object.fromEntries(placed.map((p) => [p.id, [p.lane, p.lanes]]))
  assert.deepEqual(by, { a: [0, 3], b: [1, 3], c: [2, 3], e: [0, 3], d: [0, 1] })
})
