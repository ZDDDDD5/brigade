// Pi's package: installed by the runner on first use, not carried in its bundle (pi-package.ts).
// The install itself (pnpm from npm) runs with PI_TEST_INSTALL_ROOT in pi-harness.test.ts.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PI_MANIFEST_DIR, loadPi, piInstallDir } from '../src/pi-package.js'

const runner = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  files: string[]
}

test('the bundle carries Pi’s manifest, not Pi: the version the repository tests is the one runners install', async () => {
  assert.equal(runner.dependencies['@ai-sdk/harness-pi'], undefined)
  assert.ok(runner.files.includes('pi'))
  const manifest = JSON.parse(await readFile(join(PI_MANIFEST_DIR, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  const version = runner.devDependencies['@ai-sdk/harness-pi']
  assert.ok(version)
  assert.deepEqual(manifest.dependencies, { '@ai-sdk/harness-pi': version })
  // `--frozen-lockfile` refuses a lockfile that doesn't match the manifest.
  const lock = await readFile(join(PI_MANIFEST_DIR, 'pnpm-lock.yaml'), 'utf8')
  assert.match(
    lock,
    new RegExp(`'@ai-sdk/harness-pi':\\n\\s+specifier: ${version.replaceAll('.', '\\.')}\\n`),
  )
})

test('in the repository, Pi is the devDependency’s', async () => {
  const pi = await loadPi()
  assert.equal(typeof pi.createPi, 'function')
})

test('a finished install is used as it is, with no new install', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-package-'))
  try {
    const root = join(dir, 'pi')
    const installed = await piInstallDir(PI_MANIFEST_DIR, root)
    const pkg = join(installed, 'node_modules', '@ai-sdk', 'harness-pi')
    await mkdir(join(pkg, 'dist'), { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ type: 'module', exports: { '.': { import: './dist/index.js' } } }),
    )
    await writeFile(join(pkg, 'dist', 'index.js'), 'export const createPi = () => "installed"\n')
    const pi = await loadPi({ fromPackage: false, root })
    assert.equal((pi.createPi as unknown as () => string)(), 'installed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a new lockfile installs in a folder of its own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-package-'))
  try {
    await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n')
    const other = await piInstallDir(dir, '/x')
    assert.notEqual(other, await piInstallDir(PI_MANIFEST_DIR, '/x'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
