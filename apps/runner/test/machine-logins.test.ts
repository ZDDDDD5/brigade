// On Windows without the vendor's CLI, a login is known by its file: the person's own Claude Code
// or Codex sign-in is used as it is, never asked for again.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { machineLogins } from '../src/accounts.js'
import { bootstrapDir } from '../src/vendor-cli.js'
import { existsSync } from 'node:fs'

const noCli =
  process.platform !== 'win32' ||
  existsSync(bootstrapDir('claude')) ||
  existsSync(bootstrapDir('codex'))

test('Windows: logins found by their files', { skip: noCli }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'brigade-logins-'))
  const saved = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR }
  delete process.env.CODEX_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  try {
    assert.deepEqual(await machineLogins(home), [
      { provider: 'claude_code', loggedIn: false },
      { provider: 'codex', loggedIn: false },
    ])
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'auth.json'), '{}')
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', '.credentials.json'), '{}')
    assert.deepEqual(await machineLogins(home), [
      { provider: 'claude_code', loggedIn: true },
      { provider: 'codex', loggedIn: true },
    ])
  } finally {
    if (saved.codex !== undefined) process.env.CODEX_HOME = saved.codex
    if (saved.claude !== undefined) process.env.CLAUDE_CONFIG_DIR = saved.claude
  }
})
