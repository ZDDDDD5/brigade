import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeThread, setPinned, shownThread, withShown } from '../lib/optimistic-threads'

/** Requests that wait until released, recording what each asked for. */
function controlled() {
  const sent: boolean[] = []
  const pending: { resolve: () => void; reject: (e: Error) => void }[] = []
  const send = (pinned: boolean) => {
    sent.push(pinned)
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))
  return { sent, pending, send, tick }
}

test('a pin shows at once, until the request is in and the list reloaded', async () => {
  const { sent, pending, send, tick } = controlled()
  let reloads = 0
  const done = setPinned('a', true, send, () => {
    reloads++
  })
  assert.ok(shownThread('a')?.pinnedAt)
  const row = withShown(
    { id: 'a', pinnedAt: null as string | null },
    new Map([['a', shownThread('a')!]]),
  )
  assert.ok(row.pinnedAt)
  assert.deepEqual(sent, [true])
  assert.equal(reloads, 0)
  pending[0]!.resolve()
  await done
  assert.equal(reloads, 1)
  assert.equal(shownThread('a'), undefined)
  await tick()
})

test('a click while a request goes waits for it, and only the latest wish is sent', async () => {
  const { sent, pending, send, tick } = controlled()
  let reloads = 0
  const reload = () => {
    reloads++
  }
  const first = setPinned('b', true, send, reload)
  // Unpin, then pin again, then unpin while the first is out: one more request, the latest.
  await setPinned('b', false, send, reload)
  await setPinned('b', true, send, reload)
  await setPinned('b', false, send, reload)
  assert.equal(shownThread('b')?.pinnedAt, null)
  assert.deepEqual(sent, [true])
  pending[0]!.resolve()
  await tick()
  assert.deepEqual(sent, [true, false])
  assert.equal(reloads, 0)
  pending[1]!.resolve()
  await first
  assert.equal(reloads, 1)
  assert.equal(shownThread('b'), undefined)
})

test('a refused request stops showing ahead once reloaded, and says why', async () => {
  const { pending, send } = controlled()
  let reloads = 0
  const done = setPinned('c', true, send, () => {
    reloads++
  })
  pending[0]!.reject(new Error('Not found'))
  await assert.rejects(done, /Not found/)
  assert.equal(reloads, 1)
  assert.equal(shownThread('c'), undefined)
})

test('a click during the reload keeps showing its own pin', async () => {
  const { pending, send, tick } = controlled()
  let release!: () => void
  const first = setPinned('d', true, send, () => new Promise<void>((r) => (release = r)))
  pending[0]!.resolve()
  await tick()
  // Reloading now: unpin it.
  const second = setPinned('d', false, send, () => undefined)
  release()
  await first
  assert.equal(shownThread('d')?.pinnedAt, null)
  pending[1]!.resolve()
  await second
  assert.equal(shownThread('d'), undefined)
})

test('a snooze and a pin of the same thread show together, each with its own requests', async () => {
  const { pending, tick } = controlled()
  const sent: string[] = []
  const send = (what: string) => {
    sent.push(what)
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
  }
  const pinned = setPinned(
    'e',
    true,
    () => send('pin'),
    () => undefined,
  )
  const snoozed = changeThread(
    'e',
    'later',
    { until: '2026-11-16T08:00:00.000Z' },
    { laterAt: '2026-11-15T10:00:00.000Z', snoozedUntil: '2026-11-16T08:00:00.000Z' },
    (wish) => send(`later:${wish.until}`),
    () => undefined,
  )
  assert.deepEqual(sent, ['pin', 'later:2026-11-16T08:00:00.000Z'])
  const row = withShown(
    { id: 'e', pinnedAt: null, laterAt: null },
    new Map([['e', shownThread('e')!]]),
  )
  assert.ok(row.pinnedAt)
  assert.equal(row.laterAt, '2026-11-15T10:00:00.000Z')
  pending[1]!.resolve()
  await snoozed
  // The pin still goes: it still shows, the snooze no more.
  assert.ok(shownThread('e')?.pinnedAt)
  assert.equal(shownThread('e')?.laterAt, undefined)
  pending[0]!.resolve()
  await pinned
  assert.equal(shownThread('e'), undefined)
  await tick()
})

test('a wish with a value is sent again only when it changed', async () => {
  const { pending, tick } = controlled()
  const sent: (string | null)[] = []
  const send = (until: string | null) => {
    sent.push(until)
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
  }
  const later = (until: string | null) =>
    changeThread(
      'f',
      'later',
      until,
      { laterAt: until && 'now', snoozedUntil: until },
      send,
      () => undefined,
    )
  const first = later('tomorrow')
  // Unsnoozed, then snoozed until tomorrow again while the first goes: nothing more to send.
  await later(null)
  await later('tomorrow')
  pending[0]!.resolve()
  await first
  assert.deepEqual(sent, ['tomorrow'])
  assert.equal(shownThread('f'), undefined)
  await tick()
})
