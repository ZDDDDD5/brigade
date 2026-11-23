// A Codex sign-in on a member's machine runs the harnesses' own copy of the CLI, not the one on
// the PATH: a Mac's Codex from before October 2025 has no `login --device-auth`, and each sign-in
// on it failed at once, saying only "For more information, try '--help'." (vendor-cli.ts).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-sign-in-cli-'))
process.env.BRIGADE_ACCOUNTS_DIR = join(home, 'accounts')
process.env.HOME = home
test.after(() => rm(home, { recursive: true, force: true, maxRetries: 10 }))
const { Accounts } = await import('../src/accounts.js')
const { vendorCli } = await import('../src/vendor-cli.js')

const codex = { id: 'acct-old', provider: 'codex', source: 'brigade' } as never
const claude = { id: 'acct-claude', provider: 'claude_code', source: 'brigade' } as never

/** A sign-in's result, with the CLI `cli` gives and what it was asked for. */
async function signIn(
  cli: (vendor: string, options: object) => Promise<[string, string[]]>,
  account = codex,
) {
  const asked: object[] = []
  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const accounts = new Accounts(
      { prompt: () => undefined, done: (_id, result) => resolve(result) },
      (async (vendor: string, options: object) => {
        asked.push(options)
        return cli(vendor, options)
      }) as never,
    )
    void accounts.start('login', account)
  })
  return { result: await done, asked }
}

test("a member's machine signs in to Codex with the harnesses' own CLI, installed if need be", async () => {
  const fail = async (): Promise<[string, string[]]> => [
    process.execPath,
    ['-e', 'process.exit(1)'],
  ]
  assert.deepEqual((await signIn(fail)).asked, [{ install: true, own: true }])
  // Claude's sign-in, status and sign-out (a Mac's keychain) stay with the machine's own CLI.
  assert.deepEqual((await signIn(fail, claude)).asked, [{ install: true, own: false }])
})

test("a CLI that refuses the sign-in's flags says why, not its usage's last line", async () => {
  // What Codex 0.42 writes for `codex login --device-auth`, then exits 2.
  const usage =
    "error: unexpected argument '--device-auth' found\n\nUsage: codex login [OPTIONS] [COMMAND]\n\n" +
    "For more information, try '--help'.\n"
  const { result } = await signIn(async () => [
    process.execPath,
    ['-e', `process.stderr.write(${JSON.stringify(usage)}); process.exit(2)`],
  ])
  assert.deepEqual(result, { ok: false, error: "error: unexpected argument '--device-auth' found" })
})

test('off Windows, the PATH CLI reads the machine, and the own copy is only there once installed', async () => {
  if (process.platform === 'win32') return
  const bin = join(home, 'path-bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
  assert.deepEqual(await vendorCli('codex', { path: bin }), ['codex', []])
  // Not installed in this home, and not asked to install: none.
  assert.equal(await vendorCli('codex', { own: true, path: bin }), undefined)
})

test("a Mac without the claude command (only the Claude app) signs in with the harnesses' copy", async () => {
  if (process.platform === 'win32') return
  const empty = join(home, 'empty-path')
  await mkdir(empty, { recursive: true })
  // Was ['claude', []] whatever the PATH held, and the sign-in failed: spawn claude ENOENT.
  assert.equal(await vendorCli('claude', { path: empty }), undefined)
  // Installed by then (a turn's bootstrap, or the sign-in's own install): that copy.
  const cli = join(
    home,
    '.ai-sdk-harness',
    '.harness-bootstrap',
    'claude-code',
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
  )
  await mkdir(cli, { recursive: true })
  await writeFile(join(cli, 'claude.exe'), '#!/bin/sh\n', { mode: 0o755 })
  assert.deepEqual(await vendorCli('claude', { path: empty }), [join(cli, 'claude.exe'), []])
  // A command of their own on the PATH still comes first.
  await writeFile(join(empty, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  assert.deepEqual(await vendorCli('claude', { path: empty }), ['claude', []])
})

test('a machine with no claude to ask installs its own copy to read the login', async () => {
  if (process.platform === 'win32') return
  const { missingCli } = await import('../src/vendor-cli.js')
  const empty = join(home, 'empty-path-2')
  await mkdir(empty, { recursive: true })
  // Installed in this home by the test above: not missing.
  assert.equal(missingCli('claude', empty), false)
  await rm(join(home, '.ai-sdk-harness'), { recursive: true, force: true })
  assert.equal(missingCli('claude', empty), true)
  await writeFile(join(empty, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(missingCli('claude', empty), false, 'one of their own on the PATH')
})
