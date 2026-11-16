// Pi (@ai-sdk/harness-pi, harness/pi.ts), installed by the runner the first time a teammate runs on
// it, rather than carried in the runner's bundle.
//
// Its dependencies (pi-coding-agent, and the OpenAI, Google and AWS SDKs of pi-ai) took the bundle
// from 19 MB to 46 MB, past the 25 MiB a Worker asset may be, and the API serves the bundle as one:
// #888's deploy failed on it, as #849's had with agent-desktop's binaries (agent-desktop.ts). Pi is
// behind the pi_harness feature, so only the runners of the workspaces that have it ever need it.
//
// The bundle carries Pi's manifest and lockfile (apps/runner/pi). On first use the runner installs
// exactly that tree with the pnpm it carries (`--frozen-lockfile`: pnpm checks each package against
// the integrity the lockfile pins), beside the runner (<install dir>/pi/<lockfile hash>), where a
// runner update leaves it. A new lockfile installs a new folder. In the repository (development,
// tests) the devDependency's copy is used.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** What the runner uses of Pi's package. */
export type PiPackage = typeof import('@ai-sdk/harness-pi')

/** The runner's own folder (dist/..), where the bundle keeps Pi's manifest and lockfile (pi/). */
const RUNNER_DIR = fileURLToPath(new URL('..', import.meta.url))
export const PI_MANIFEST_DIR = join(RUNNER_DIR, 'pi')

/** Where installs go: beside the runner (<install dir>/pi), not inside it, so updates keep them. */
export const PI_INSTALL_ROOT = join(dirname(RUNNER_DIR.replace(/\/$/, '')), 'pi')

/** The longest an install may take: a stalled one fails, and the next turn on Pi tries again. */
export const PI_INSTALL_DEADLINE_MS = 5 * 60_000

const PACKAGE = '@ai-sdk/harness-pi'

/** Where the lockfile in `manifestDir` installs: one folder per lockfile. */
export async function piInstallDir(manifestDir = PI_MANIFEST_DIR, root = PI_INSTALL_ROOT) {
  const lock = await readFile(join(manifestDir, 'pnpm-lock.yaml'))
  return join(root, createHash('sha256').update(lock).digest('hex').slice(0, 16))
}

/** The package's entry in an install folder, if it holds a finished install. */
async function entryIn(dir: string): Promise<string | undefined> {
  const pkg = join(dir, 'node_modules', ...PACKAGE.split('/'))
  const manifest = await readFile(join(pkg, 'package.json'), 'utf8').catch(() => undefined)
  if (!manifest) return
  const exports = (JSON.parse(manifest) as { exports?: { '.'?: { import?: string } } }).exports
  const entry = join(pkg, exports?.['.']?.import ?? 'dist/index.js')
  return existsSync(entry) ? entry : undefined
}

/** pnpm's CLI, from the runner's own dependencies (the bundle carries it). */
function pnpmCli() {
  return join(
    dirname(createRequire(import.meta.url).resolve('pnpm')), // its one export: package.json
    'bin',
    'pnpm.cjs',
  )
}

async function install(manifestDir: string, dir: string, deadlineMs: number) {
  await mkdir(dirname(dir), { recursive: true, mode: 0o755 })
  // Installed next to where it goes, then moved there whole: a runner stopped halfway leaves no
  // half-installed folder where the next look would find it.
  const staging = await mkdtemp(`${dir}.`)
  try {
    for (const file of ['package.json', 'pnpm-lock.yaml'])
      await copyFile(join(manifestDir, file), join(staging, file))
    await run(
      process.execPath,
      [
        pnpmCli(),
        'install',
        '--frozen-lockfile',
        '--prod',
        '--ignore-workspace',
        // No dependency's install script runs (pnpm 10's default too): Pi needs none.
        '--ignore-scripts',
        '--reporter=silent',
      ],
      {
        cwd: staging,
        timeout: deadlineMs,
        maxBuffer: 16 * 1024 * 1024,
      },
    ).catch((error: { stderr?: string; killed?: boolean; message?: string }) => {
      const why = error.killed
        ? `no end within ${Math.round(deadlineMs / 1000)} seconds`
        : (error.stderr?.trim().split('\n').slice(-3).join(' ') ?? error.message ?? String(error))
      throw new Error(`Pi could not be installed: ${why}`)
    })
    if (!(await entryIn(staging))) throw new Error('Pi was installed, but its package is missing')
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

let loading: Promise<PiPackage> | undefined

/**
 * Pi's package: the devDependency's in the repository, else the runner's install of it, made
 * first if there is none yet. One install at a time; a failed one is tried again at the next call.
 */
export function loadPi(
  options: {
    manifestDir?: string
    root?: string
    /** Tests: skip the devDependency's copy, as in a runner's bundle. */
    fromPackage?: boolean
    deadlineMs?: number
  } = {},
): Promise<PiPackage> {
  const custom = options.manifestDir !== undefined || options.root !== undefined
  if (loading && !custom) return loading
  const load = (async () => {
    if (options.fromPackage ?? true) {
      try {
        return (await import(PACKAGE)) as PiPackage
      } catch (error) {
        if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error
      }
    }
    const manifestDir = options.manifestDir ?? PI_MANIFEST_DIR
    const dir = await piInstallDir(manifestDir, options.root ?? PI_INSTALL_ROOT)
    let entry = await entryIn(dir)
    if (!entry) {
      await install(manifestDir, dir, options.deadlineMs ?? PI_INSTALL_DEADLINE_MS)
      entry = await entryIn(dir)
    }
    if (!entry) throw new Error('Pi was installed, but its package is missing')
    return (await import(pathToFileURL(entry).href)) as PiPackage
  })()
  if (custom) return load
  loading = load
  // A failed load is tried again next time; a good one is kept.
  load.catch(() => {
    if (loading === load) loading = undefined
  })
  return load
}
