// A sign-in on a member's machine runs the harnesses' own copy of the vendor CLI, not the one on
// the PATH: a Mac's Codex from before October 2025 has no `login --device-auth`, and each sign-in
// on it failed at once, saying only "For more information, try '--help'." (vendor-cli.ts).
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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

/** A sign-in's result, with the CLI `cli` gives and what it was asked for. */
async function signIn(cli: (vendor: string, options: object) => Promise<[string, string[]]>) {
  const asked: object[] = []
  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const accounts = new Accounts(
      { prompt: () => undefined, done: (_id, result) => resolve(result) },
      (async (vendor: string, options: object) => {
        asked.push(options)
        return cli(vendor, options)
      }) as never,
    )
    void accounts.start('login', codex)
  })
  return { result: await done, asked }
}

test("a member's machine signs in with the harnesses' own CLI, installed if need be", async () => {
  const { asked } = await signIn(async () => [process.execPath, ['-e', 'process.exit(1)']])
  assert.deepEqual(asked, [{ install: true, own: true }])
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
  assert.deepEqual(await vendorCli('codex'), ['codex', []])
  // Not installed in this home, and not asked to install: none.
  assert.equal(await vendorCli('codex', { own: true }), undefined)
})
