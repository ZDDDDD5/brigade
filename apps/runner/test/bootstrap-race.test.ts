import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

// The runner's pnpm shim, which the harness's environment writes, somewhere of the test's own.
process.env.BRIGADE_SHIM_DIR = await mkdtemp(join(tmpdir(), 'bootstrap-race-shims-'))
const { createHarnessSandboxTemplate } = await import('@ai-sdk/harness/agent')
const { harnessEnv } = await import('../src/harness/env.js')
const { createLocalSandboxSession } = await import('../src/harness/local-sandbox.js')

type Adapter = Parameters<typeof createHarnessSandboxTemplate>[0]['harnesses'][number]

/**
 * A recipe whose install takes a while and notes when it starts and ends: two of them side by
 * side in one folder is what broke a new member's first turns (ERR_PNPM_ENOTEMPTY).
 */
const slowAdapter = {
  harnessId: 'claude-code',
  getBootstrap: async () => ({
    harnessId: 'claude-code',
    bootstrapDir: '.harness-bootstrap/claude-code',
    files: [{ path: '.harness-bootstrap/claude-code/bridge.mjs', content: 'export {}\n' }],
    commands: [{ command: 'echo start >> runs.txt; sleep 0.3; echo end >> runs.txt' }],
  }),
} as unknown as Adapter

async function prepare(
  home: string,
  abortSignal = AbortSignal.timeout(30_000),
  adapter: Adapter = slowAdapter,
  /** Each call the bootstrap makes on the sandbox, by name. */
  onCall?: (name: string) => void,
) {
  const template = await createHarnessSandboxTemplate({ harnesses: [adapter] })
  const local = createLocalSandboxSession({
    id: 'test',
    workingDirectory: home,
    port: 0,
    env: harnessEnv({ HOME: home }),
  })
  const session: typeof local = onCall
    ? {
        ...local,
        run: (options) => (onCall('run'), local.run(options)),
        readTextFile: (options) => (onCall('readTextFile'), local.readTextFile(options)),
        writeTextFile: (options) => (onCall('writeTextFile'), local.writeTextFile(options)),
      }
    : local
  await template!.prepare({ session, abortSignal })
}

const runsIn = (home: string) =>
  readFile(join(home, '.ai-sdk-harness', '.harness-bootstrap', 'claude-code', 'runs.txt'), 'utf8')

/** Until a file holds something: the first turn's install under way, so the next one waits. */
async function until(read: () => Promise<string>) {
  for (let i = 0; i < 200; i++) {
    if (await read().catch(() => '')) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the first install never started')
}

test('two turns starting together on one computer install the harness once', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bootstrap-race-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  await Promise.all([prepare(home), prepare(home), prepare(home)])

  // One install, never two side by side: the others waited, then found its marker.
  assert.equal(await runsIn(home), 'start\nend\n')
})

test('turns in different homes do not wait on each other', async (t) => {
  const a = await mkdtemp(join(tmpdir(), 'bootstrap-race-a-'))
  const b = await mkdtemp(join(tmpdir(), 'bootstrap-race-b-'))
  const log = join(await mkdtemp(join(tmpdir(), 'bootstrap-race-log-')), 'runs.txt')
  t.after(() =>
    Promise.all([a, b, dirname(log)].map((dir) => rm(dir, { recursive: true, force: true }))),
  )
  // Both installs note into one file: side by side, both start before either ends.
  const adapter = {
    harnessId: 'claude-code',
    getBootstrap: async () => ({
      harnessId: 'claude-code',
      bootstrapDir: '.harness-bootstrap/claude-code',
      files: [],
      commands: [{ command: `echo start >> '${log}'; sleep 0.5; echo end >> '${log}'` }],
    }),
  } as unknown as Adapter

  await Promise.all([prepare(a, undefined, adapter), prepare(b, undefined, adapter)])
  assert.equal(await readFile(log, 'utf8'), 'start\nstart\nend\nend\n')
})

test('a turn stopped while it waits stops waiting, and the install it waited on goes on', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bootstrap-race-abort-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const first = prepare(home)
  await until(() => runsIn(home))
  const stop = new AbortController()
  const second = prepare(home, stop.signal)
  setTimeout(() => stop.abort(new Error('stopped')), 50)

  await assert.rejects(second, /stopped/)
  await first
  assert.equal(await runsIn(home), 'start\nend\n')
  // A later turn finds the marker and installs nothing.
  await prepare(home)
  assert.equal(await runsIn(home), 'start\nend\n')
})

test('a turn stopped while it waits runs nothing, even when the install before it fails', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bootstrap-race-fail-'))
  const log = join(await mkdtemp(join(tmpdir(), 'bootstrap-race-fail-log-')), 'runs.txt')
  t.after(() =>
    Promise.all([home, dirname(log)].map((dir) => rm(dir, { recursive: true, force: true }))),
  )
  // Its install fails after a while, before writing its marker.
  const failing = {
    harnessId: 'claude-code',
    getBootstrap: async () => ({
      harnessId: 'claude-code',
      bootstrapDir: '.harness-bootstrap/claude-code',
      files: [],
      commands: [{ command: `echo run >> '${log}'; sleep 0.3; exit 1` }],
    }),
  } as unknown as Adapter

  const first = prepare(home, undefined, failing)
  await until(() => readFile(log, 'utf8'))
  const stop = new AbortController()
  // What the stopped turn does on its sandbox once stopped: its session is gone by then.
  const afterStop: string[] = []
  const second = prepare(home, stop.signal, failing, (name) => {
    if (stop.signal.aborted) afterStop.push(name)
  })
  setTimeout(() => stop.abort(new Error('stopped')), 50)

  await assert.rejects(second, /stopped/)
  await assert.rejects(first, /Bootstrap command failed/)
  // Long enough for a queued install to have started, had it been let through.
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.deepEqual(afterStop, [])
  assert.equal(await readFile(log, 'utf8'), 'run\n')
  // The next turn tries again.
  await assert.rejects(prepare(home, undefined, failing), /Bootstrap command failed/)
  assert.equal(await readFile(log, 'utf8'), 'run\nrun\n')
})

test("a runner of another version on the same home finds its own bridge, never the other's", async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bootstrap-race-versions-'))
  const log = join(await mkdtemp(join(tmpdir(), 'bootstrap-race-versions-log-')), 'runs.txt')
  t.after(() =>
    Promise.all([home, dirname(log)].map((dir) => rm(dir, { recursive: true, force: true }))),
  )
  const dir = join(home, '.ai-sdk-harness', '.harness-bootstrap', 'claude-code')
  const markers = async () => (await readdir(dir)).filter((f) => f.startsWith('.bootstrap-'))
  const bridge = () => readFile(join(dir, 'bridge.mjs'), 'utf8')
  // This runner's recipe: a key-pair bridge.
  const current = {
    harnessId: 'claude-code',
    getBootstrap: async () => ({
      harnessId: 'claude-code',
      bootstrapDir: '.harness-bootstrap/claude-code',
      files: [{ path: '.harness-bootstrap/claude-code/bridge.mjs', content: '// key pair\n' }],
      commands: [{ command: `echo install >> '${log}'` }],
    }),
  } as unknown as Adapter
  // What a runner from before does, with its own recipe: it writes its token bridge over the
  // folder, then, once its install went through, its marker beside the others, which it leaves.
  const older = async ({ installed = true } = {}) => {
    await writeFile(join(dir, 'bridge.mjs'), '// token\n')
    if (installed) await writeFile(join(dir, '.bootstrap-older.ok'), '')
  }

  await mkdir(dir, { recursive: true })
  await older()
  // Updated: it installs its own, and the older marker goes, so that a runner rolled back to the
  // older version installs its own again rather than start this one's bridge.
  await prepare(home, undefined, current)
  assert.equal(await bridge(), '// key pair\n')
  assert.equal((await markers()).length, 1)
  assert.ok(!(await markers()).includes('.bootstrap-older.ok'))
  // Rolled back, then forward again: the older runner's files over its own, it installs again.
  await older()
  await prepare(home, undefined, current)
  assert.equal(await bridge(), '// key pair\n')
  // So when the older runner's install failed after it wrote its files, leaving no marker.
  await older({ installed: false })
  await prepare(home, undefined, current)
  assert.equal(await bridge(), '// key pair\n')
  // Its own install there, it installs nothing.
  await prepare(home, undefined, current)
  assert.equal(await readFile(log, 'utf8'), 'install\ninstall\ninstall\n')
})
