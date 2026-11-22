// The runner installer, run for real against a bundle served here: whole, or in the two steps
// an updating runner takes (stage while it works, swap once its turns are handed over).
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { installScript } = await import('../src/routes/runner-install.js')
const { NODE_VERSION } = await import('@brigade/contracts')

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'brigade-install-'))
test.after(() => rm(root, { recursive: true, force: true }))

/** A bundle as the API serves it: one top folder holding dist/index.js. */
async function bundle(name: string, version: string) {
  const dir = join(root, name)
  await mkdir(join(dir, 'package', 'dist'), { recursive: true })
  await writeFile(
    join(dir, 'package', 'dist', 'index.js'),
    `console.log(${JSON.stringify(version)})\n`,
  )
  spawnSync('tar', ['-czf', join(dir, 'bundle.tgz'), '-C', dir, 'package'])
  const bytes = readFileSync(join(dir, 'bundle.tgz'))
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** A stand-in node: a script that says whether it is recent enough (the installer's question). */
async function fakeNode(dir: string, recent: boolean) {
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeFile(join(dir, 'bin', 'node'), `#!/bin/sh\nexit ${recent ? 0 : 1}\n`)
  await chmod(join(dir, 'bin', 'node'), 0o755)
}

/** NODE_VERSION's downloads, as nodejs.org/dist serves them for this platform: .tar.gz and .tar.xz. */
const platform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`
const nodeFiles = new Map<string, Buffer>()
const nodeSums = await (async () => {
  const dir = join(root, 'dist')
  await fakeNode(join(dir, `node-${NODE_VERSION}`), true)
  await writeFile(join(dir, `node-${NODE_VERSION}`, 'bin', 'marker'), NODE_VERSION)
  let sums = ''
  for (const [ext, flag] of [
    ['tar.gz', '-czf'],
    ['tar.xz', '-cJf'],
  ]) {
    const file = `node-${NODE_VERSION}-${platform}.${ext}`
    spawnSync('tar', [flag, join(dir, file), '-C', dir, `node-${NODE_VERSION}`])
    const bytes = readFileSync(join(dir, file))
    nodeFiles.set(`/dist/${NODE_VERSION}/${file}`, bytes)
    sums += `${createHash('sha256').update(bytes).digest('hex')}  ${file}\n`
  }
  return sums
})()

/**
 * A PATH holding only the tools a minimal Debian or Ubuntu install has: no xz, and curl only
 * when asked.
 */
async function minimalPath(name: string, { curl = true } = {}) {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  const tools = ['sh', 'mkdir', 'tar', 'gzip', 'uname', 'mktemp', 'grep', 'cut', 'sed', 'tail']
  tools.push('rm', 'mv', 'cat', 'chmod', 'sha256sum', 'shasum', 'dirname', 'env')
  if (curl) tools.push('curl')
  for (const tool of tools) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    if (found) await symlink(found, join(dir, tool))
  }
  return dir
}

let served = await bundle('one', 'one')
const server = createServer((req, res) => {
  const node = nodeFiles.get(req.url ?? '')
  if (node) return res.writeHead(200).end(node)
  if (req.url === `/dist/${NODE_VERSION}/SHASUMS256.txt`) return res.writeHead(200).end(nodeSums)
  if (req.url !== '/runner/bundle.tgz') return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': 'application/gzip', 'x-bundle-sha256': served.sha256 })
  res.end(served.bytes)
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
test.after(() => server.close())
const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const install = (dir: string, step?: 'stage' | 'swap', path = process.env.PATH) =>
  execFileAsync('sh', ['-c', installScript(api)], {
    env: {
      ...process.env,
      PATH: path,
      BRIGADE_NODE_DIST: `${api}/dist`,
      BRIGADE_INSTALL_DIR: dir,
      ...(step ? { BRIGADE_INSTALL_STEP: step } : { BRIGADE_INSTALL_STEP: '' }),
    },
  })
const stamp = (dir: string) => readFileSync(join(dir, '.bundle-sha256'), 'utf8').trim()

test('a first install puts the runner and its wrapper in place', async () => {
  const dir = join(root, 'fresh')
  await install(dir)
  assert.equal(stamp(join(dir, 'runner')), served.sha256)
  assert.ok(existsSync(join(dir, 'bin', 'brigade-runner')))
  assert.ok(!existsSync(join(dir, 'runner.new')))
})

test('an update downloads beside the running runner, then swaps it in', async () => {
  const dir = join(root, 'updating')
  await install(dir)
  const before = served.sha256
  served = await bundle('two', 'two')

  await install(dir, 'stage')
  // Staged: the running runner and its wrapper are as they were.
  assert.equal(stamp(join(dir, 'runner')), before)
  assert.equal(stamp(join(dir, 'runner.new')), served.sha256)

  await install(dir, 'swap')
  assert.equal(stamp(join(dir, 'runner')), served.sha256)
  assert.match(readFileSync(join(dir, 'runner', 'dist', 'index.js'), 'utf8'), /two/)
  assert.ok(!existsSync(join(dir, 'runner.new')))
  assert.ok(existsSync(join(dir, 'bin', 'brigade-runner')))
})

test('a swap with nothing staged changes nothing', async () => {
  const dir = join(root, 'nothing-staged')
  await install(dir)
  const before = stamp(join(dir, 'runner'))
  await assert.rejects(install(dir, 'swap'))
  assert.equal(stamp(join(dir, 'runner')), before)
})

test('a Node.js older than NODE_VERSION is replaced, beside the runner while it works', async () => {
  const dir = join(root, 'old-node')
  // The computer's own node is old too: the installer's copy is the one to bring up to date.
  const oldNode = join(root, 'old-system-node')
  await fakeNode(oldNode, false)
  const path = `${join(oldNode, 'bin')}:${process.env.PATH}`
  await install(dir, undefined, path)
  assert.equal(readFileSync(join(dir, 'node', 'bin', 'marker'), 'utf8'), NODE_VERSION)
  // Installed before NODE_VERSION came out.
  await rm(join(dir, 'node'), { recursive: true })
  await fakeNode(join(dir, 'node'), false)
  served = await bundle('three', 'three')

  await install(dir, 'stage', path)
  assert.ok(!existsSync(join(dir, 'node', 'bin', 'marker')))
  assert.equal(readFileSync(join(dir, 'node.new', 'bin', 'marker'), 'utf8'), NODE_VERSION)

  await install(dir, 'swap', path)
  assert.equal(readFileSync(join(dir, 'node', 'bin', 'marker'), 'utf8'), NODE_VERSION)
  assert.ok(!existsSync(join(dir, 'node.new')))
  assert.ok(!existsSync(join(dir, 'node.old')))
  assert.match(readFileSync(join(dir, 'bin', 'brigade-runner'), 'utf8'), /\/node\/bin\/node"/)
})

test('a computer without xz gets Node.js all the same', async () => {
  const dir = join(root, 'no-xz')
  // A Debian or Ubuntu install without xz-utils, and no Node.js of its own.
  await install(dir, undefined, await minimalPath('minimal-bin'))
  assert.equal(readFileSync(join(dir, 'node', 'bin', 'marker'), 'utf8'), NODE_VERSION)
  assert.ok(existsSync(join(dir, 'bin', 'brigade-runner')))
})

test('a computer without curl is told to install it', async () => {
  const dir = join(root, 'no-curl')
  const failed = await install(
    dir,
    undefined,
    await minimalPath('no-curl-bin', { curl: false }),
  ).then(
    () => null,
    (error: { stderr: string }) => error,
  )
  assert.ok(failed, 'the install should fail')
  assert.match(failed.stderr, /needs curl.*sudo apt install curl/)
  assert.ok(!existsSync(join(dir, 'bin', 'brigade-runner')))
})
