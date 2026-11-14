import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setPinned, shownPin, withShownPin } from '../lib/optimistic-pins'

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
  assert.ok(shownPin('a')?.pinnedAt)
  const row = withShownPin(
    { id: 'a', pinnedAt: null as string | null },
    new Map([['a', shownPin('a')!]]),
  )
  assert.ok(row.pinnedAt)
  assert.deepEqual(sent, [true])
  assert.equal(reloads, 0)
  pending[0]!.resolve()
  await done
  assert.equal(reloads, 1)
  assert.equal(shownPin('a'), undefined)
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
  assert.equal(shownPin('b')?.pinnedAt, null)
  assert.deepEqual(sent, [true])
  pending[0]!.resolve()
  await tick()
  assert.deepEqual(sent, [true, false])
  assert.equal(reloads, 0)
  pending[1]!.resolve()
  await first
  assert.equal(reloads, 1)
  assert.equal(shownPin('b'), undefined)
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
  assert.equal(shownPin('c'), undefined)
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
  assert.equal(shownPin('d')?.pinnedAt, null)
  pending[1]!.resolve()
  await second
  assert.equal(shownPin('d'), undefined)
})
