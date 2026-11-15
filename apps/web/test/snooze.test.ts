import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wakeLabel } from '../lib/snooze'

// Sunday 15 November 2026, 14:00 in the browser's own timezone.
const now = new Date('2026-11-15T14:00:00')
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

test('a snooze’s end reads as the time today, Tomorrow, a weekday, then a date', () => {
  assert.equal(wakeLabel('2026-11-15T17:00:00', now), time('2026-11-15T17:00:00'))
  assert.equal(wakeLabel('2026-11-16T09:00:00', now), `Tomorrow ${time('2026-11-16T09:00:00')}`)
  assert.match(wakeLabel('2026-11-20T09:00:00', now), /\S+ /)
  assert.doesNotMatch(wakeLabel('2026-11-20T09:00:00', now), /Tomorrow/)
  assert.equal(
    wakeLabel('2026-12-15T14:00:00', now),
    new Date('2026-12-15T14:00:00').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    }),
  )
})
