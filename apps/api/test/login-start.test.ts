import assert from 'node:assert/strict'
import { test } from 'node:test'

// Onboarding's "Sign in with …" sent twice (two tabs, two clicks) reuses one account row
// (routes/accounts.ts); in the hub, the second request must not replace the attempt whose link
// the member may have opened already: with keepLive it is returned as it stands (src/logins.ts).
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { inHub } = await import('../src/hub/context.js')
const { startLogin, loginForAccount, endLogin, updateLogin, loginRows } =
  await import('../src/logins.js')
// The account's row, as the test sets it (no database here).
let ready = false
loginRows.ready = async () => ready

function fakeHub() {
  const maps = new Map<string, Map<string, unknown>>()
  const dispatched: { loginId: string }[] = []
  const hub = {
    workspaceId: 'ws-login-start',
    durable: (key: string) => {
      if (!maps.has(key)) maps.set(key, new Map())
      return maps.get(key)
    },
    dispatch: async (_computer: unknown, message: { loginId: string }) => {
      dispatched.push(message)
      // The runner's answer takes a while: a second request comes in meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 10))
      return 'sent'
    },
    sendToMember: () => undefined,
  }
  return { hub: hub as never, dispatched }
}

const input = {
  accountId: 'acct-1',
  memberId: 'm-1',
  computerId: 'c-1',
  account: { id: 'acct-1', provider: 'claude_code', source: 'brigade' } as never,
}
const computer = { id: 'c-1', kind: 'member_machine' }

test('two requests at once with keepLive make one attempt, and keep it', async () => {
  ready = false
  const { hub, dispatched } = fakeHub()
  await inHub(hub, async () => {
    await Promise.all([
      startLogin(input, computer, { keepLive: true }),
      startLogin(input, computer, { keepLive: true }),
    ])
    assert.equal(dispatched.length, 1, 'one sign-in started on the computer')
    const first = loginForAccount('acct-1')!
    assert.equal(first.loginId, dispatched[0]!.loginId)
    // A later retry while it is under way: still that one.
    await startLogin(input, computer, { keepLive: true })
    assert.equal(dispatched.length, 1)
    assert.equal(loginForAccount('acct-1')!.loginId, first.loginId)
    // Once it ended (failed, cancelled), a retry starts a new one.
    endLogin(first.loginId)
    await startLogin(input, computer, { keepLive: true })
    assert.equal(dispatched.length, 2)
  })
})

test('without keepLive (Sign in again), a new attempt replaces the one under way', async () => {
  const { hub, dispatched } = fakeHub()
  await inHub(hub, async () => {
    await startLogin(input, computer)
    await startLogin(input, computer)
    assert.equal(dispatched.length, 2)
    assert.equal(loginForAccount('acct-1')!.loginId, dispatched[1]!.loginId)
  })
})

test('a retry as an attempt succeeds starts no other: finishing, then ready', async () => {
  ready = false
  const { hub, dispatched } = fakeHub()
  await inHub(hub, async () => {
    await startLogin(input, computer, { keepLive: true })
    const first = loginForAccount('acct-1')!
    // The runner said it succeeded; its row is being written (noteLogin): the attempt stays.
    updateLogin(first.loginId, { finishing: true })
    await startLogin(input, computer, { keepLive: true })
    assert.equal(dispatched.length, 1)
    // Written ready, then ended: a retry finds the row ready and starts nothing.
    ready = true
    endLogin(first.loginId)
    assert.equal(await startLogin(input, computer, { keepLive: true }), 'ready')
    assert.equal(dispatched.length, 1)
    assert.equal(loginForAccount('acct-1'), undefined)
  })
})
