import assert from 'node:assert/strict'
import { test } from 'node:test'

// machine.logins, once the runner's own Claude Code is installed, is read when the API has
// welcomed the connection and sent only on that same connection: a value read while away, or
// across a reconnect, could be older than a hello since (a sign-out meanwhile). It is not dropped
// either (src/send-once-connected.ts).
const { sendOnceConnected } = await import('../src/send-once-connected.js')

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('read once welcomed: a sign-out while away is what is sent', async () => {
  let welcome: number | undefined
  let signedIn = true
  const sent: boolean[] = []
  setTimeout(() => (signedIn = false), 10)
  setTimeout(() => (welcome = 1), 25)
  const result = await sendOnceConnected(
    () => welcome,
    async () => signedIn,
    (value) => {
      sent.push(value)
      return true
    },
    { everyMs: 5, tries: 50 },
  )
  assert.equal(result, 'sent')
  assert.deepEqual(sent, [false], 'read once, after the welcome, signed out')
})

test('a reconnect during the read: nothing stale is sent on the new connection', async () => {
  // Read on connection 1 (signed in); it drops; signed out; connection 2's hello says so.
  let welcome: number | undefined = 1
  let signedIn = true
  const sent: boolean[] = []
  const result = await sendOnceConnected(
    () => welcome,
    async () => {
      const value = signedIn
      welcome = undefined
      signedIn = false
      await tick(5)
      welcome = 2
      return value
    },
    (value) => {
      sent.push(value)
      return true
    },
    { everyMs: 1, tries: 5 },
  )
  assert.equal(result, 'superseded')
  assert.deepEqual(sent, [], 'the read from connection 1 is never sent')
})

test('refused on the same connection: it waits and reads again', async () => {
  let reads = 0
  let sends = 0
  const result = await sendOnceConnected(
    () => 1,
    async () => ++reads,
    () => ++sends >= 2,
    { everyMs: 1, tries: 5 },
  )
  assert.equal(result, 'sent')
  assert.equal(reads, 2)
})

test('never welcomed: nothing read, it gives up', async () => {
  let reads = 0
  const result = await sendOnceConnected(
    () => undefined,
    async () => ++reads,
    () => true,
    { everyMs: 1, tries: 3 },
  )
  assert.equal(result, 'gave up')
  assert.equal(reads, 0)
})
