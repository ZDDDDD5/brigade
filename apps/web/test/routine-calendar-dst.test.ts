// The drop across Europe's DST changes, as a browser in Paris sees the grid. Its own file: the
// timezone is set before anything reads a date, for this process only.
process.env.TZ = 'Europe/Paris'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { droppedAt, movedCron, runsClipped } from '../lib/routine-calendar'

const weekly = { kind: 'weekly' as const, hour: 1, minute: 30, day: 0 }

test('a run dropped across the spring change lands at the time the grid shows', () => {
  // Sunday 28 March 2027: clocks jump from 02:00 to 03:00. Dragged two hours down from 01:30.
  const at = droppedAt(new Date(2027, 2, 28, 1, 30), 0, 120)
  assert.equal(movedCron(weekly, at, 'Europe/Paris'), '30 3 * * 0')
})

test('a run dropped across the autumn change lands at the time the grid shows', () => {
  // Sunday 31 October 2027: clocks go back from 03:00 to 02:00. Dragged 15 minutes from 02:45.
  const at = droppedAt(new Date(2027, 9, 31, 2, 45), 0, 15)
  assert.equal(movedCron({ ...weekly, hour: 2, minute: 45 }, at, 'Europe/Paris'), '0 3 * * 0')
})

test('a weekly run dragged to another day keeps the time the grid shows', () => {
  // Saturday 27 March 01:30 to Sunday 28 March (the change's day) 04:00.
  const at = droppedAt(new Date(2027, 2, 27, 1, 30), 1, 150)
  assert.equal(movedCron({ ...weekly, day: 6 }, at, 'Europe/Paris'), '0 4 * * 0')
})

test('a week whose earlier runs did not come with the schedule says so', () => {
  const run = (day: number) => ({ createdAt: new Date(2026, 10, day, 8).toISOString() })
  const monday = new Date(2026, 10, 16)
  const made = new Date(2026, 9, 1).toISOString()
  const twiceDaily = [17, 17, 18, 18, 19, 19, 20, 20].map(run)
  assert.equal(runsClipped({ createdAt: made, recentRuns: twiceDaily }, monday), true)
  // Its oldest run is before the week: the week holds them all.
  assert.equal(
    runsClipped({ createdAt: made, recentRuns: [run(15), ...twiceDaily.slice(1)] }, monday),
    false,
  )
  // Fewer than eight: all of them came.
  assert.equal(runsClipped({ createdAt: made, recentRuns: twiceDaily.slice(2) }, monday), false)
})
