import assert from 'node:assert/strict'
import { test } from 'node:test'

// machine.logins, read once the runner's own Claude Code is installed, can be ready before the
// API welcomed the connection (sendIfConnected refuses it then): it is kept and sent once taken,
// not dropped (src/send-once-connected.ts).
const { sendOnceConnected } = await import('../src/send-once-connected.js')

test('a report made before the welcome is sent once the connection takes it', async () => {
  let welcomed = false
  const sent: number[] = []
  let attempt = 0
  setTimeout(() => (welcomed = true), 25)
  const delivered = await sendOnceConnected(
    () => {
      attempt++
      if (!welcomed) return false
      sent.push(attempt)
      return true
    },
    { everyMs: 10, tries: 50 },
  )
  assert.equal(delivered, true)
  assert.equal(sent.length, 1, 'sent once')
  assert.ok(attempt > 1, 'refused first, before the welcome')
})

test('never taken: it gives up after its tries', async () => {
  assert.equal(await sendOnceConnected(() => false, { everyMs: 1, tries: 3 }), false)
})
