import assert from 'node:assert/strict'
import { test } from 'node:test'

// machine.logins, once the runner's own Claude Code is installed, is read when the API has
// welcomed the connection, not before: a value read while away could be older than a hello since
// (a sign-out meanwhile). It is not dropped either (src/send-once-connected.ts).
const { sendOnceConnected } = await import('../src/send-once-connected.js')

test('read and sent once welcomed: a sign-out while away is what is sent', async () => {
  let connected = false
  let signedIn = true
  const sent: boolean[] = []
  // Away; signed out meanwhile; then welcomed (its hello said signed out too).
  setTimeout(() => (signedIn = false), 10)
  setTimeout(() => (connected = true), 25)
  const delivered = await sendOnceConnected(
    () => connected,
    async () => {
      sent.push(signedIn)
      return true
    },
    { everyMs: 5, tries: 50 },
  )
  assert.equal(delivered, true)
  assert.deepEqual(sent, [false], 'read once, after the welcome, signed out')
})

test('lost between the read and the send: it waits and reads again', async () => {
  let reads = 0
  const delivered = await sendOnceConnected(
    () => true,
    async () => ++reads >= 2,
    { everyMs: 1, tries: 5 },
  )
  assert.equal(delivered, true)
  assert.equal(reads, 2)
})

test('never welcomed: nothing read, it gives up after its tries', async () => {
  let reads = 0
  const delivered = await sendOnceConnected(
    () => false,
    async () => {
      reads++
      return true
    },
    { everyMs: 1, tries: 3 },
  )
  assert.equal(delivered, false)
  assert.equal(reads, 0)
})
