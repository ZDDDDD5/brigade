// What #902's review found, each through the code that had it: a desktop action stopped before
// it starts never runs; a sign-in cancelled while its CLI installs never starts, nor removes the
// folder of the one that replaced it; the commands a harness runs are told from its own children.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-review-'))
process.env.BRIGADE_ACCOUNTS_DIR = join(home, 'accounts')
test.after(() => rm(home, { recursive: true, force: true, maxRetries: 10 }))
const { localDesktopExec } = await import('../src/harness/windows-computer.js')
const { Accounts } = await import('../src/accounts.js')
const { commandsOf } = await import('../src/windows.js')

test('a desktop action stopped before it starts never runs', async () => {
  const marker = join(home, 'acted')
  const exec = localDesktopExec(async () => process.execPath)
  const stop = new AbortController()
  stop.abort()
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); console.log('{}')`
  await assert.rejects(exec(['-e', script], { signal: stop.signal }), /aborted/)
  // Stopped while its binary was found: still nothing.
  const late = new AbortController()
  const slow = localDesktopExec(async () => {
    late.abort()
    return process.execPath
  })
  await assert.rejects(slow(['-e', script], { signal: late.signal }), /aborted/)
  await new Promise((done) => setTimeout(done, 300))
  assert.equal(existsSync(marker), false)
})

test('a sign-in cancelled while its CLI installs never starts, and leaves the folder to the next', async () => {
  let release!: () => void
  const installed = new Promise<void>((done) => (release = done))
  const cli = async (): Promise<[string, string[]]> => {
    await installed
    // A login command that waits, as codex login does for its device code.
    return [process.execPath, ['-e', 'setTimeout(() => {}, 5000)']]
  }
  const done: [string, { ok: boolean; error?: string }][] = []
  const accounts = new Accounts(
    { prompt: () => undefined, done: (id, result) => done.push([id, result]) },
    cli as never,
  )
  const account = { id: 'acct1', provider: 'codex', source: 'brigade' } as never
  const first = accounts.start('first', account)
  await new Promise((r) => setImmediate(r))
  accounts.cancel('first')
  const second = accounts.start('second', account)
  await new Promise((r) => setImmediate(r))
  assert.equal(accounts.busy, true)
  release()
  await Promise.all([first, second])
  assert.deepEqual(done, [['first', { ok: false, error: 'Cancelled' }]])
  // The second runs; its folder is there.
  assert.ok(existsSync(join(home, 'accounts', 'acct1')))
  accounts.cancel('second')
  assert.equal(done.at(-1)?.[0], 'second')
})

test("a harness's commands are its shells, not its other children", () => {
  // bash (1) → node bridge (2) → codex.exe (3) → powershell (4) → node (5); codex's code-mode
  // host (6) and an MCP server (7) are its children too, and stay. An unrelated shell (8) too.
  const procs = [
    { pid: 1, ppid: 100, name: 'bash.exe' },
    { pid: 2, ppid: 1, name: 'node.exe' },
    { pid: 3, ppid: 2, name: 'codex.exe' },
    { pid: 4, ppid: 3, name: 'powershell.exe' },
    { pid: 5, ppid: 4, name: 'node.exe' },
    { pid: 6, ppid: 3, name: 'codex-code-mode-host.exe' },
    { pid: 7, ppid: 3, name: 'node.exe' },
    { pid: 8, ppid: 100, name: 'powershell.exe' },
  ]
  assert.deepEqual(commandsOf([1], procs, []).sort(), [4, 5])
})
