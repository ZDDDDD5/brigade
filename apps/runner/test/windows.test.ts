// The runner's Windows layer (windows.ts): paths between Git Bash and Windows, the PATH, process
// trees. Each runs where it can: the conversions everywhere, what needs Windows on Windows (CI's
// Windows job).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseWindowsProcesses } from '../src/process-groups.js'
import { createLocalSandboxSession, freePort } from '../src/harness/local-sandbox.js'
import {
  groupAlive,
  ownGroup,
  posixShell,
  prependPath,
  stopTree,
  toMsys,
  toNative,
  WINDOWS,
} from '../src/windows.js'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

test('Windows paths as Git Bash writes them', () => {
  assert.equal(toMsys('C:\\Users\\Ada\\.brigade\\threads\\x'), '/c/Users/Ada/.brigade/threads/x')
  assert.equal(toMsys('D:/work/'), '/d/work')
  assert.equal(toMsys('C:\\'), '/c')
  // Not a Windows path: as it is.
  assert.equal(toMsys('/home/ada'), '/home/ada')
  assert.equal(toMsys('relative\\x'), 'relative\\x')
})

test('Git Bash paths as Windows takes them', { skip: !WINDOWS }, () => {
  const cwd = 'C:\\Users\\Ada\\thread'
  assert.equal(toNative('/c/Users/Ada/x.txt', cwd), 'C:\\Users\\Ada\\x.txt')
  assert.equal(toNative('/d', cwd), 'D:\\')
  assert.equal(toNative('C:/Users/Ada/x.txt', cwd), 'C:\\Users\\Ada\\x.txt')
  assert.equal(toNative('C:\\Users\\Ada\\x.txt', cwd), 'C:\\Users\\Ada\\x.txt')
  assert.equal(toNative('notes/a.md', cwd), 'C:\\Users\\Ada\\thread\\notes\\a.md')
  assert.equal(toNative('/tmp/x', cwd), join(tmpdir(), 'x'))
})

test('a PATH with folders first, once each', () => {
  const sep = WINDOWS ? ';' : ':'
  assert.equal(prependPath(['a', 'b', 'c'].join(sep), ['c', 'd']), ['c', 'd', 'a', 'b'].join(sep))
  assert.equal(prependPath(undefined, ['x']), 'x')
})

test("Windows' process list, each process its own group", () => {
  const now = 1_000_000
  assert.deepEqual(parseWindowsProcesses('4 0 3600\r\n812 4 12\r\n\r\nbad line\r\n', now), [
    { pid: 4, ppid: 0, pgid: 4, started: now - 3_600_000 },
    { pid: 812, ppid: 4, pgid: 812, started: now - 12_000 },
  ])
})

test('a process tree stops as one', async () => {
  // A shell that starts a child of its own and waits: stopping the shell's tree ends both.
  const child = spawn(posixShell(), ['-c', 'sleep 60 & echo $!; wait'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    ...ownGroup(),
  })
  const inner = Number(
    await new Promise<string>((done) => child.stdout!.once('data', (d: Buffer) => done(String(d)))),
  )
  assert.ok(groupAlive(child.pid!))
  stopTree(child.pid!)
  for (let i = 0; i < 100 && groupAlive(child.pid!); i++) await sleep(100)
  assert.ok(!groupAlive(child.pid!))
  // On Windows the inner pid is Git Bash's own, not Windows': the shell's end is what is checked.
  if (!WINDOWS) {
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(inner, 0)
      } catch {
        break
      }
      await sleep(100)
    }
    assert.throws(() => process.kill(inner, 0))
  }
})

test('the local sandbox runs commands and reads and writes files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-sandbox-'))
  const sandbox = createLocalSandboxSession({
    id: 'windows-test',
    workingDirectory: dir,
    port: await freePort(),
    env: { ...(process.env as Record<string, string>) },
  })
  try {
    // The harness sees POSIX paths: Git Bash's on Windows.
    const shown = sandbox.defaultWorkingDirectory
    assert.ok(shown.startsWith('/'))
    const pwd = await sandbox.run({ command: 'pwd' })
    assert.equal(pwd.exitCode, 0)
    // Git Bash may name the folder its own way (/tmp for the temporary folder): the same folder.
    assert.equal(toNative(pwd.stdout.trim(), dir).toLowerCase(), dir.toLowerCase())
    const home = await sandbox.run({ command: 'printf "%s" "$HOME"' })
    assert.ok(home.stdout.startsWith('/'), home.stdout)
    // Files written by path, as the harness gives them, and by a command, meet.
    await sandbox.writeTextFile({ path: `${shown}/a.txt`, content: 'from the harness' })
    assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'from the harness')
    const made = await sandbox.run({ command: 'mkdir -p sub && printf made > sub/b.txt' })
    assert.equal(made.exitCode, 0)
    assert.equal(await sandbox.readTextFile({ path: `${shown}/sub/b.txt` }), 'made')
    assert.equal(await sandbox.readTextFile({ path: 'sub/b.txt' }), 'made')
    assert.deepEqual((await sandbox.listDirectory({ path: shown }))?.map((e) => e.name).sort(), [
      'a.txt',
      'sub',
    ])
    assert.equal((await sandbox.stat({ path: `${shown}/sub` }))?.type, 'directory')
    assert.equal(await sandbox.deleteFile({ path: `${shown}/a.txt` }), true)
    // A Windows program started from bash gets a Windows path.
    const node = await sandbox.run({
      command: `node -e "console.log(require('fs').existsSync(process.argv[1]))" "${shown}/sub/b.txt"`,
    })
    assert.equal(node.stdout.trim(), 'true', node.stderr)
  } finally {
    await sandbox.destroy()
    await rm(dir, { recursive: true, force: true })
  }
})
