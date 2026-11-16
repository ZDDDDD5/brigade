// The supervisor on Windows, against a fake runner: a script node runs as install.ps1 sets it up
// (bin\node-path.txt, runner\dist\index.js), stopped over its IPC channel, started again when it
// exits 75 (an update), and installed by a fake install.ps1. Windows only (CI's Windows job).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { Supervisor, type Status } from '../src/runner.js'

const windows = process.platform === 'win32'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'brigade-runner-'))
  process.env.BRIGADE_HOME = home
})
afterEach(() => {
  delete process.env.BRIGADE_HOME
})

/** The runner: `start` runs `body` (JavaScript); `link` writes runner.json as the real one does. */
function runner(body: string, dir = home) {
  mkdirSync(join(dir, 'bin'), { recursive: true })
  mkdirSync(join(dir, 'runner', 'dist'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'node-path.txt'), process.execPath)
  writeFileSync(
    join(dir, 'runner', 'dist', 'index.js'),
    `const fs = require('fs'), path = require('path')
const home = process.env.BRIGADE_HOME
const note = (what) => fs.appendFileSync(path.join(home, 'notes'), what + '\\n')
if (process.argv[2] === 'link') {
  if (process.argv[3] !== 'good') process.exit(1)
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ workspaceName: 'Acme', apiUrl: process.argv[5], workspaceId: 'ws_1' }))
  process.exit(0)
}
${body}
`,
  )
}

const linked = (dir = home) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'runner.json'),
    JSON.stringify({ workspaceName: 'Acme', apiUrl: 'https://api.test' }),
  )
}

function supervisor() {
  const seen: Status[] = []
  const s = new Supervisor({
    onChange: (status) => seen.push(status),
    graceMs: 5_000,
    backoffMs: 50,
    runningElsewhere: async () => false,
  })
  return { s, seen }
}

const notes = () =>
  existsSync(join(home, 'notes'))
    ? readFileSync(join(home, 'notes'), 'utf8').trim().split(/\r?\n/)
    : []

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(25)
  }
}

test('runs node with the runner, and stops it over IPC', { skip: !windows }, async () => {
  linked()
  runner(`note('start ' + process.env.BRIGADE_SUPERVISED)
process.on('message', (m) => { if (m === 'brigade:stop') { note('stop'); process.exit(0) } })
setInterval(() => {}, 1000)`)
  const { s } = supervisor()
  await s.start()
  await until(() => notes().includes('start 1') && s.status.kind === 'running')
  await s.stop()
  assert.ok(notes().includes('stop'), notes().join(','))
  assert.equal(s.status.kind, 'stopped')
})

test(
  'starts the runner again at once when it updated itself (75)',
  { skip: !windows },
  async () => {
    linked()
    runner(`const runs = (fs.existsSync(path.join(home, 'notes')) ? fs.readFileSync(path.join(home, 'notes'), 'utf8').split('\\n').filter(Boolean).length : 0)
note('run')
if (runs === 0) process.exit(75)
process.on('message', () => process.exit(0))
setInterval(() => {}, 1000)`)
    const { s, seen } = supervisor()
    await s.start()
    await until(() => notes().length === 2 && s.status.kind === 'running')
    assert.ok(!seen.some((st) => st.kind === 'restarting'), JSON.stringify(seen))
    await s.stop()
  },
)

test('a runner that finds another one running stays out', { skip: !windows }, async () => {
  linked()
  runner('process.exit(3)')
  const { s } = supervisor()
  await s.start()
  await until(() => s.status.kind === 'elsewhere')
  await s.stop()
})

test('connects: installs with install.ps1, links, then runs', { skip: !windows }, async () => {
  // The API's installer: here, one that sets up the fake runner as the real one would.
  const entry = join(home, 'fake-entry.js')
  writeFileSync(entry, "process.on('message', () => process.exit(0)); setInterval(() => {}, 1000)")
  const script = `$ErrorActionPreference = 'Stop'
$Dir = $env:BRIGADE_INSTALL_DIR
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'bin'), (Join-Path $Dir 'runner\\dist') | Out-Null
[IO.File]::WriteAllText((Join-Path $Dir 'bin\\node-path.txt'), '${process.execPath.replace(/'/g, "''")}')
Copy-Item -LiteralPath '${join(home, 'link.js').replace(/'/g, "''")}' -Destination (Join-Path $Dir 'runner\\dist\\index.js')
`
  writeFileSync(
    join(home, 'link.js'),
    `const fs = require('fs'), path = require('path')
if (process.argv[2] === 'link') {
  if (process.argv[3] !== 'good') process.exit(1)
  fs.writeFileSync(path.join(process.env.BRIGADE_HOME, 'runner.json'), JSON.stringify({ workspaceName: 'Acme', apiUrl: process.argv[5], workspaceId: 'ws_1' }))
  process.exit(0)
}
require(${JSON.stringify(entry)})
`,
  )
  const server = createServer((req, res) => {
    if (req.url === '/runner/install.ps1') res.end(script)
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const { s, seen } = supervisor()
    assert.match((await s.connect(api, 'expired', 'ws_1')) ?? '', /did not work/)
    assert.ok(!existsSync(join(home, 'runner.json')))
    assert.equal(await s.connect(api, 'good', 'ws_1'), undefined)
    assert.ok(seen.some((st) => st.kind === 'installing'))
    await until(() => s.status.kind === 'running')
    await s.stop()
  } finally {
    server.close()
  }
})
