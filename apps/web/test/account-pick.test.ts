import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultAccount, pickAccount, pickComputer } from '../lib/account-pick'

// Ada's default on the cloud computer was added first; Bob's own came later.
const adas = { id: 'ada', mine: false, isDefault: true }
const bobs = { id: 'bob', mine: true, isDefault: true }

test("a member's own default comes before a shared one added earlier", () => {
  assert.equal(defaultAccount([adas, bobs])?.id, 'bob')
})

test('their own account, even not default, before a shared one', () => {
  assert.equal(defaultAccount([adas, { ...bobs, isDefault: false }])?.id, 'bob')
})

test('without one of their own, the shared default', () => {
  assert.equal(defaultAccount([{ id: 'cat', mine: false, isDefault: false }, adas])?.id, 'ada')
})

test('a pick stays, while it is usable', () => {
  assert.equal(pickAccount([adas, bobs], 'ada')?.id, 'ada')
  assert.equal(pickAccount([adas, bobs], 'gone')?.id, 'bob')
})

test('a new thread goes to the computer that has an account it can run on, unless one was picked', () => {
  const cloud = { id: 'cloud' }
  const mac = { id: 'mac' }
  const claude = { computer: mac, provider: 'claude_code' }
  const runs = (a: { provider: string }) => a.provider === 'claude_code'
  // The cloud computer is listed first, the Claude login is on the Mac.
  assert.equal(pickComputer([cloud, mac], [claude], runs)?.id, 'mac')
  assert.equal(pickComputer([cloud, mac], [claude], runs, 'cloud')?.id, 'cloud')
  // Nowhere to run: the first, where the box says why.
  assert.equal(pickComputer([cloud, mac], [], runs)?.id, 'cloud')
  assert.equal(pickComputer([], [claude], runs), undefined)
})
