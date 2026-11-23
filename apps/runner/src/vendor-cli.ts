// The vendor CLIs that sign accounts in and read their limits: `claude` and `codex`. On macOS and
// Linux, the ones on the PATH, as the person installed them, except a Codex sign-in; when none is
// (a Mac with only the Claude app, which has no `claude` command: a sign-in failed with "spawn
// claude ENOENT"), the harnesses' copy, as on Windows. On Windows,
// where the people Brigade runs for rarely have them, and for a Codex sign-in anywhere (`own`),
// the copies the harnesses install for their turns anyway, in the same folder
// (~/.ai-sdk-harness/.harness-bootstrap/<harness>), installed by the sign-in when missing: the
// same files and the same `pnpm install`, so a turn's bootstrap finds them there, with nothing
// downloaded twice. A Mac's own `codex` can be older than the sign-in's flags: Codex before
// October 2025 has no `login --device-auth`, and a sign-in on it failed at once with its usage.
// Turns themselves always run the harnesses' copies (harness/index.ts).
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { harnessEnv } from './harness/env.js'
import { WINDOWS } from './windows.js'

export type Vendor = 'claude' | 'codex'

const require = createRequire(import.meta.url)

/** What each harness package's bootstrap writes, and where its CLI is once installed. */
const VENDORS = {
  claude: {
    harness: '@ai-sdk/harness-claude-code',
    dir: 'claude-code',
    files: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    cli: ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
    node: false,
  },
  codex: {
    harness: '@ai-sdk/harness-codex',
    dir: 'codex',
    files: ['package.json', 'pnpm-lock.yaml'],
    cli: ['node_modules', '@openai', 'codex', 'bin', 'codex.js'],
    node: true,
  },
} as const

/** Where a harness package keeps its bridge's files: pnpm-lock.yaml is pnpm-lockfile.yaml there. */
const asset = (harness: string, file: string) =>
  join(
    dirname(require.resolve(harness)),
    'bridge',
    file === 'pnpm-lock.yaml' ? 'pnpm-lockfile.yaml' : file,
  )

/** The harnesses' install folder for a vendor (HarnessAgent's state directory, in the home). */
export const bootstrapDir = (vendor: Vendor, home = homedir()) =>
  join(home, '.ai-sdk-harness', '.harness-bootstrap', VENDORS[vendor].dir)

/** The installed CLI, if it is. */
function installed(vendor: Vendor, home?: string): [string, string[]] | undefined {
  const cli = join(bootstrapDir(vendor, home), ...VENDORS[vendor].cli)
  if (!existsSync(cli)) return undefined
  return VENDORS[vendor].node ? [process.execPath, [cli]] : [cli, []]
}

const installing = new Map<Vendor, Promise<void>>()

/** Install a vendor's CLI as the harness's bootstrap does: its files, then `pnpm install`. */
async function install(vendor: Vendor) {
  const dir = bootstrapDir(vendor)
  await mkdir(dir, { recursive: true })
  for (const file of VENDORS[vendor].files)
    await writeFile(join(dir, file), readFileSync(asset(VENDORS[vendor].harness, file)))
  const pnpm = join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.cjs')
  await new Promise<void>((resolve, reject) =>
    execFile(
      process.execPath,
      [pnpm, 'install', '--frozen-lockfile', '--store-dir', '.pnpm-store'],
      { cwd: dir, env: harnessEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, _stdout, stderr) =>
        error
          ? reject(
              new Error(
                `Could not install ${vendor}: ${stderr.trim().slice(-300) || error.message}`,
              ),
            )
          : resolve(),
    ),
  )
}

/** Whether a command of that name is on the PATH (the person's, harness/env.ts usePersonPath). */
export function onPath(name: string, path = process.env.PATH ?? ''): boolean {
  return path.split(delimiter).some((dir) => {
    if (!dir) return false
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) return false
      accessSync(file, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/**
 * The command that runs a vendor's CLI, and the arguments it starts with: its name on macOS and
 * Linux when it is on the PATH; on Windows, with `own` on any system, or when the PATH has none,
 * the harnesses' copy, installed first when `install` and missing. Undefined when that copy is
 * wanted, is not installed and `install` is false.
 */
export async function vendorCli(
  vendor: Vendor,
  options: { install?: boolean; own?: boolean; path?: string } = {},
): Promise<[string, string[]] | undefined> {
  if (!WINDOWS && !options.own && onPath(vendor, options.path)) return [vendor, []]
  const found = installed(vendor)
  if (found || !options.install) return found
  let pending = installing.get(vendor)
  if (!pending) {
    pending = install(vendor).finally(() => installing.delete(vendor))
    installing.set(vendor, pending)
  }
  await pending
  return installed(vendor)
}

/**
 * Off Windows, a machine with neither the vendor's command nor the harnesses' copy: one with only
 * the Claude app, whose Claude Code login (from another tool, or the Claude app's Code) only a
 * claude can read. Such a runner installs its copy (installOwnClaude) and reads its logins again.
 */
export const missingCli = (vendor: Vendor, path?: string) =>
  !WINDOWS && !onPath(vendor, path) && !installed(vendor)
