// install.ps1, run for real by Windows PowerShell against a bundle served here: whole, or in the
// two steps an updating runner takes. Windows only (CI's Windows job); skipped elsewhere.
// Node's download is this Node itself, zipped as nodejs.org serves it; Git for Windows is taken as
// installed already (its folder holds bin\bash.exe), since its self-extractor cannot be faked.
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'

const windows = process.platform === 'win32'
const { windowsInstallScript, GIT_FOR_WINDOWS } =
  await import('../src/routes/runner-install-windows.js')
const { NODE_VERSION } = await import('@brigade/contracts')

const execFileAsync = promisify(execFile)

type Entry = { path: string; type: 'dir' | 'file' | 'link'; content?: string; target?: string }

/** A tar archive (ustar), as bundle.sh makes the runner's: folders, files and links. */
function tar(entries: Entry[]) {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    const body = Buffer.from(entry.content ?? '')
    header.write(entry.type === 'dir' ? `${entry.path}/` : entry.path, 0, 100)
    header.write(entry.type === 'dir' ? '0000755\0' : '0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(
      `${(entry.type === 'file' ? body.length : 0).toString(8).padStart(11, '0')}\0`,
      124,
    )
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write(entry.type === 'dir' ? '5' : entry.type === 'link' ? '2' : '0', 156)
    if (entry.target) header.write(entry.target, 157, 100)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header)
    if (entry.type === 'file') {
      blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** A bundle as the API serves it: runner/dist/index.js, a pnpm-style link, and its list. */
function bundle(version: string) {
  const link = 'node_modules/dep'
  // Relative to the link's folder, as pnpm writes them.
  const target = '.pnpm/dep@1/node_modules/dep'
  const bytes = tar([
    { path: 'runner', type: 'dir' },
    { path: 'runner/dist', type: 'dir' },
    {
      path: 'runner/dist/index.js',
      type: 'file',
      content: `console.log(${JSON.stringify(version)})\n`,
    },
    { path: 'runner/node_modules', type: 'dir' },
    { path: 'runner/node_modules/.pnpm/dep@1/node_modules/dep', type: 'dir' },
    {
      path: 'runner/node_modules/.pnpm/dep@1/node_modules/dep/index.js',
      type: 'file',
      content: `module.exports = ${JSON.stringify(version)}\n`,
    },
    { path: `runner/${link}`, type: 'link', target },
    { path: 'runner/.symlinks', type: 'file', content: `${link}\t${target}\n` },
  ])
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

test('install.ps1 installs, links and updates the runner', { skip: !windows }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'brigade-install-'))
  try {
    // Node.js: this one, in the zip nodejs.org serves for Windows.
    const nodeName = `node-${NODE_VERSION}-win-x64`
    const nodeDir = join(root, 'node-src', nodeName)
    await mkdir(nodeDir, { recursive: true })
    copyFileSync(process.execPath, join(nodeDir, 'node.exe'))
    const zip = join(root, `${nodeName}.zip`)
    spawnSync(join(process.env.SystemRoot!, 'System32', 'tar.exe'), [
      '-a',
      '-cf',
      zip,
      '-C',
      join(root, 'node-src'),
      nodeName,
    ])
    const zipBytes = readFileSync(zip)
    const sums = `${createHash('sha256').update(zipBytes).digest('hex')}  ${nodeName}.zip\n`

    let served = bundle('one')
    const server = createServer((req, res) => {
      if (req.url === `/dist/${NODE_VERSION}/${nodeName}.zip`)
        return res.writeHead(200).end(zipBytes)
      if (req.url === `/dist/${NODE_VERSION}/SHASUMS256.txt`) return res.writeHead(200).end(sums)
      if (req.url !== '/runner/bundle.tgz') return res.writeHead(404).end()
      res.writeHead(200, { 'x-bundle-sha256': served.sha256 }).end(served.bytes)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const script = join(root, 'install.ps1')
    await writeFile(script, `﻿${windowsInstallScript(api)}`)

    const dir = join(root, 'home')
    // Git for Windows, taken as installed (its archive cannot be faked).
    const git = join(dir, `git-${GIT_FOR_WINDOWS.version}-x64`)
    await mkdir(join(git, 'bin'), { recursive: true })
    await writeFile(join(git, 'bin', 'bash.exe'), '')

    const install = (step = '') =>
      execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        {
          env: {
            ...process.env,
            BRIGADE_NODE_DIST: `${api}/dist`,
            BRIGADE_INSTALL_DIR: dir,
            BRIGADE_INSTALL_STEP: step,
          },
        },
      )
    const stamp = (folder: string) => readFileSync(join(folder, '.bundle-sha256'), 'utf8').trim()
    const runner = join(dir, 'runner')
    const node = join(dir, nodeName, 'node.exe')
    const run = () => spawnSync(node, [join(runner, 'dist', 'index.js')], { encoding: 'utf8' })

    try {
      await install()
      assert.equal(stamp(runner), served.sha256)
      assert.equal(readFileSync(join(dir, 'bin', 'node-path.txt'), 'utf8'), node)
      assert.equal(readFileSync(join(dir, 'bin', 'git-path.txt'), 'utf8'), git)
      assert.match(readFileSync(join(dir, 'bin', 'brigade-runner.cmd'), 'utf8'), /\r\n/)
      assert.equal(run().stdout.trim(), 'one')
      // pnpm's link is a junction to its package, in this folder.
      const link = join(runner, 'node_modules', 'dep')
      assert.ok(lstatSync(link).isSymbolicLink())
      assert.equal(
        readlinkSync(link).replace(/\\$/, ''),
        join(runner, 'node_modules', '.pnpm', 'dep@1', 'node_modules', 'dep'),
      )
      assert.equal(readFileSync(join(link, 'index.js'), 'utf8').trim(), 'module.exports = "one"')

      // An update: staged beside the running runner, then swapped in.
      const before = served.sha256
      served = bundle('two')
      await install('stage')
      assert.equal(stamp(runner), before)
      assert.equal(stamp(join(dir, 'runner.new')), served.sha256)
      await install('swap')
      assert.equal(stamp(runner), served.sha256)
      assert.equal(run().stdout.trim(), 'two')
      assert.ok(!existsSync(join(dir, 'runner.new')))
      assert.ok(!existsSync(join(dir, 'runner.old')))
      // The junction points into the new runner, and the old one's files went with it.
      assert.equal(
        readFileSync(join(runner, 'node_modules', 'dep', 'index.js'), 'utf8').trim(),
        'module.exports = "two"',
      )

      // A swap with nothing staged changes nothing.
      await assert.rejects(install('swap'))
      assert.equal(stamp(runner), served.sha256)
    } finally {
      server.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
