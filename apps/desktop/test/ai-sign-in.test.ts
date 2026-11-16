// The setup window's last screen offers to connect Claude or ChatGPT only when no sign-in is here.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { hasAiSignIn } from '../src/ai-sign-in.js'

const saved = { ...process.env }
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'brigade-ai-'))
  for (const key of ['BRIGADE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) delete process.env[key]
})
afterEach(() => {
  process.env = { ...saved }
})

// A Mac also asks its keychain, which the computer running the tests may hold.
test('nothing signed in', { skip: process.platform === 'darwin' }, async () => {
  assert.equal(await hasAiSignIn(home), false)
})

test("the person's own Codex login", async () => {
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex', 'auth.json'), '{}')
  assert.equal(await hasAiSignIn(home), true)
})

test("the person's own Claude Code login", async () => {
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}')
  assert.equal(await hasAiSignIn(home), true)
})

test('an account signed in through Brigade', async () => {
  mkdirSync(join(home, '.brigade', 'accounts', 'acc_1'), { recursive: true })
  assert.equal(await hasAiSignIn(home), true)
})
