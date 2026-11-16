import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addDays,
  dayIndex,
  hoursShown,
  missedRuns,
  movableOf,
  movedCron,
  runsBetween,
  slotCron,
  stackOut,
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

test('runs close in time stack in one card, in time order', () => {
  const cards = stackOut(
    [
      { id: 'morning', minute: 570 },
      { id: 'watch', minute: 540 },
      { id: 'reddit', minute: 540 },
      { id: 'noon', minute: 720 },
    ],
    24,
  )
  assert.deepEqual(
    cards.map((c) => [c.minute, c.items.map((i) => i.id)]),
    [
      [540, ['watch', 'reddit', 'morning']],
      [720, ['noon']],
    ],
  )
  // A run just past the card's last row starts a card of its own.
  assert.equal(stackOut([{ minute: 540 }, { minute: 564 }], 24).length, 2)
})

test('firings that could not start, since its last run started', () => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = new Date(2026, 10, 19, 15, 0)
  const daily = {
    cron: '0 8 * * *',
    timezone: tz,
    lastError: "None of Ada's computers was online",
    pausedAt: null,
    createdAt: new Date(2026, 9, 1).toISOString(),
    recentRuns: [{ createdAt: new Date(2026, 10, 17, 8, 0, 4).toISOString() }],
  }
  // Ran on Tuesday; Wednesday and Thursday at 8:00 did not start.
  assert.deepEqual(missedRuns(daily, monday, now), [
    new Date(2026, 10, 18, 8),
    new Date(2026, 10, 19, 8),
  ])
  // Its last firing started: nothing is missed, whatever its runs.
  assert.deepEqual(missedRuns({ ...daily, lastError: null }, monday, now), [])
  assert.deepEqual(missedRuns({ ...daily, pausedAt: now.toISOString() }, monday, now), [])
  // Never ran: from when it was made.
  const made = new Date(2026, 10, 18, 12).toISOString()
  assert.deepEqual(missedRuns({ ...daily, recentRuns: [], createdAt: made }, monday, now), [
    new Date(2026, 10, 19, 8),
  ])
})

test('the grid shows the hours around the runs and now, the rest folded', () => {
  assert.deepEqual(hoursShown([8 * 60, 9 * 60 + 30, 15 * 60 + 15]), { from: 7, to: 17 })
  assert.deepEqual(hoursShown([9 * 60]), { from: 8, to: 14 })
  assert.deepEqual(hoursShown([30, 23 * 60 + 30]), { from: 0, to: 24 })
  assert.deepEqual(hoursShown([23 * 60]), { from: 18, to: 24 })
  assert.deepEqual(hoursShown([]), { from: 8, to: 18 })
})
