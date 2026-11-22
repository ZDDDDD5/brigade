// The setup window's last screen offers to connect Claude or ChatGPT only when no sign-in is here.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { hasAiSignIn } from '../src/ai-sign-in.js'

const saved = { ...process.env }
let home: string
/** The runner home of the workspace this computer runs (not ~/.brigade, for a second one). */
let workspace: string

const account = (base: string, id: string, file?: [string, string]) => {
  const dir = join(base, 'accounts', id)
  mkdirSync(dir, { recursive: true })
  if (file) writeFileSync(join(dir, file[0]), file[1])
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'brigade-ai-'))
  workspace = join(home, '.brigade', 'workspaces', 'w1')
  mkdirSync(workspace, { recursive: true })
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']) delete process.env[key]
})
afterEach(() => {
  process.env = { ...saved }
})

// A Mac also asks its keychain, which the computer running the tests may hold.
const mac = process.platform === 'darwin'

test('nothing signed in', { skip: mac }, async () => {
  assert.equal(await hasAiSignIn(workspace, home), false)
})

test("the person's own Codex login", async () => {
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex', 'auth.json'), '{}')
  assert.equal(await hasAiSignIn(workspace, home), true)
})

test("the person's own Claude Code login", async () => {
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude', '.credentials.json'), '{}')
  assert.equal(await hasAiSignIn(workspace, home), true)
})

test("an account signed in through Brigade, in the running workspace's home", async () => {
  account(workspace, 'acc_1', ['auth.json', '{}'])
  assert.equal(await hasAiSignIn(workspace, home), true)
})

test('a Claude account whose login is in the keychain: its settings name the account', async () => {
  account(workspace, 'acc_1', ['.claude.json', JSON.stringify({ oauthAccount: { a: 1 } })])
  assert.equal(await hasAiSignIn(workspace, home), true)
})

test('a sign-in that never finished leaves a folder that is no login', { skip: mac }, async () => {
  account(workspace, 'acc_1')
  account(workspace, 'acc_2', ['.claude.json', '{}'])
  assert.equal(await hasAiSignIn(workspace, home), false)
})

test("another workspace's account is not this one's", { skip: mac }, async () => {
  account(join(home, '.brigade'), 'acc_1', ['auth.json', '{}'])
  assert.equal(await hasAiSignIn(workspace, home), false)
})
