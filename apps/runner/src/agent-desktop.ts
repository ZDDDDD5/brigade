// agent-desktop (vercel-labs/agent-desktop): reads an app's interface through the OS's
// accessibility API (AX on macOS, AT-SPI on Linux) and acts on its elements by ref, without
// moving the pointer or taking focus.
//
// The runner's bundle doesn't carry it: its binaries for every platform (12 MB compressed) took
// the bundle past the 25 MiB a Worker asset may be, and the API serves the bundle as one (#849's
// deploy failed on it). A runner downloads the pinned version from npm the first time a teammate
// uses it, checks it against the integrity pinned here (the lockfile's), and keeps only the
// binaries for its own platform, beside the runner (<install dir>/agent-desktop/<version>), where a
// runner update leaves them and a cloud computer's teammate users can run them. In the repository
// (development, tests) the devDependency's copy is used.
//
// Where it runs is the caller's (DesktopExec): on a member's Mac, through Brigade Computer Use,
// which holds Accessibility (harness/desktop-tools.ts); on a cloud computer, as the teammate's
// Linux user on the desktop, reading its own apps only (desktop.ts).
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The version used, and its npm tarball's integrity: the same as the devDependency's in the lockfile. */
export const AGENT_DESKTOP_VERSION = '1.3.1'
export const AGENT_DESKTOP_INTEGRITY =
  'sha512-5pBKkFkdB/VIAWRfqoA8lYp5/fenfxUHI15Pc4k8Nn2LmLxxo1PkAb0WLypknyOCczuIwuzFp/rZHGGawEV+hw=='
const TARBALL = `https://registry.npmjs.org/agent-desktop/-/agent-desktop-${AGENT_DESKTOP_VERSION}.tgz`

/** Where a runner keeps its download: beside the runner (<install dir>/runner), not inside it. */
export const AGENT_DESKTOP_DIR = join(
  dirname(fileURLToPath(new URL('..', import.meta.url))),
  'agent-desktop',
  AGENT_DESKTOP_VERSION,
)

/** The binary for this platform, and on macOS the helper it starts (beside it). */
export type AgentDesktopBinary = { path: string; macosHelper?: string }

/** agent-desktop's binary for this computer, if the runner has it already (no download). */
export function agentDesktopBinary(
  os: NodeJS.Platform = platform(),
  cpu: string = arch(),
  dir = AGENT_DESKTOP_DIR,
  /** The devDependency's copy first, where there is one (the repository). */
  fromPackage = true,
): AgentDesktopBinary | undefined {
  let bin: string | undefined
  try {
    bin = fromPackage
      ? join(dirname(createRequire(import.meta.url).resolve('agent-desktop/package.json')), 'bin')
      : undefined
  } catch {
    bin = undefined
  }
  return (bin ? binaryIn(bin, os, cpu) : undefined) ?? binaryIn(dir, os, cpu)
}

/** The binary for `os` and `cpu` in the package's bin folder. */
export function binaryIn(bin: string, os: string, cpu: string): AgentDesktopBinary | undefined {
  const names = binaryNames(os, cpu)
  if (!names) return
  const path = join(bin, names[0]!)
  if (!existsSync(path)) return
  if (os !== 'darwin') return { path }
  const macosHelper = join(bin, names[1]!)
  return existsSync(macosHelper) ? { path, macosHelper } : undefined
}

/** The files a platform needs, the binary first; none for a platform agent-desktop doesn't run on. */
function binaryNames(os: string, cpu: string) {
  if ((os !== 'darwin' && os !== 'linux') || (cpu !== 'arm64' && cpu !== 'x64')) return
  return os === 'darwin'
    ? [`agent-desktop-${os}-${cpu}`, `agent-desktop-macos-helper-${os}-${cpu}`]
    : [`agent-desktop-${os}-${cpu}`, `agent-desktop-linux-clipboard-owner-${os}-${cpu}`]
}

let downloading: Promise<AgentDesktopBinary> | undefined

/**
 * agent-desktop's binary for this computer, downloaded first if the runner hasn't it yet. One
 * download at a time; a failed one is tried again at the next call.
 */
export function ensureAgentDesktop(
  options: {
    os?: NodeJS.Platform
    cpu?: string
    dir?: string
    fetch?: typeof fetch
    /** Tests: the integrity their own tarball has, and no devDependency's copy. */
    integrity?: string
    fromPackage?: boolean
  } = {},
): Promise<AgentDesktopBinary> {
  const os = options.os ?? platform()
  const cpu = options.cpu ?? arch()
  const dir = options.dir ?? AGENT_DESKTOP_DIR
  const have = agentDesktopBinary(os, cpu, dir, options.fromPackage ?? true)
  if (have) return Promise.resolve(have)
  const integrity = options.integrity ?? AGENT_DESKTOP_INTEGRITY
  downloading ??= download(os, cpu, dir, options.fetch ?? fetch, integrity).finally(() => {
    downloading = undefined
  })
  return downloading
}

async function download(
  os: NodeJS.Platform,
  cpu: string,
  dir: string,
  get: typeof fetch,
  pinned: string,
) {
  const names = binaryNames(os, cpu)
  if (!names) throw new Error(`agent-desktop does not run on ${os} ${cpu}`)
  const response = await get(TARBALL).catch((error: unknown) => {
    throw new Error(`agent-desktop could not be downloaded: ${String(error)}`)
  })
  if (!response.ok)
    throw new Error(`agent-desktop could not be downloaded: npm answered ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (integrity !== pinned)
    throw new Error('agent-desktop was not used: its download does not match the version pinned')
  // Unpacked next to where it goes, then moved there whole: a runner stopped halfway leaves no
  // half-written binary where the next look would find it.
  await mkdir(dirname(dir), { recursive: true, mode: 0o755 })
  const staging = await mkdtemp(`${dir}.`)
  try {
    const tarball = join(staging, 'package.tgz')
    await writeFile(tarball, bytes)
    await run('tar', [
      '-xzf',
      tarball,
      '-C',
      staging,
      ...names.map((name) => `package/bin/${name}`),
    ])
    const unpacked = join(staging, 'package', 'bin')
    for (const name of names) await chmod(join(unpacked, name), 0o755)
    await chmod(unpacked, 0o755)
    await rm(dir, { recursive: true, force: true })
    await rename(unpacked, dir)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const binary = binaryIn(dir, os, cpu)
  if (!binary) throw new Error('agent-desktop was downloaded, but its binary is missing')
  return binary
}

/** Runs agent-desktop with these arguments where the caller says; resolves to its stdout. */
export type DesktopExec = (
  args: string[],
  options?: { stdin?: string; signal?: AbortSignal },
) => Promise<string>

/** What each command prints: one JSON envelope. */
export type Envelope = {
  ok: boolean
  command?: string
  data?: Record<string, unknown>
  error?: {
    code?: string
    message?: string
    suggestion?: string
    details?: unknown
    disposition?: { delivery?: string; retry?: string }
  }
}

export class DesktopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

/** The envelope in a command's output, or an error saying what came instead. */
export function parseEnvelope(stdout: string): Envelope {
  const text = stdout.trim()
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    // A notice on a line before it (the package's launcher prints one): the last line is the JSON.
    const last = text.split('\n').pop() ?? ''
    try {
      envelope = JSON.parse(last)
    } catch {
      throw new DesktopError(
        'unreadable',
        `agent-desktop printed no answer${text ? `: ${text.slice(-500)}` : ''}`,
      )
    }
  }
  if (!envelope || typeof envelope !== 'object' || typeof (envelope as Envelope).ok !== 'boolean')
    throw new DesktopError(
      'unreadable',
      `agent-desktop printed an unexpected answer: ${text.slice(0, 500)}`,
    )
  return envelope as Envelope
}

/** Run a command and return its data; a refusal is a DesktopError with agent-desktop's own words. */
export async function desktopCall(
  exec: DesktopExec,
  args: string[],
  options?: { stdin?: string; signal?: AbortSignal },
) {
  const envelope = parseEnvelope(await exec(args, options))
  if (!envelope.ok) {
    const error = envelope.error ?? {}
    const code = error.code ?? 'failed'
    const retry =
      error.disposition?.retry === 'unsafe'
        ? ' It may have happened anyway: look before you try again.'
        : ''
    // Sentences, each ended once: agent-desktop's own end with a period, or don't.
    const sentence = (text: string) =>
      /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`
    const words = [error.message ?? `${args[0]} failed`, error.suggestion].filter(
      (text): text is string => !!text?.trim(),
    )
    throw new DesktopError(code, `${code}: ${words.map(sentence).join(' ')}${retry}`, error.details)
  }
  return envelope.data ?? {}
}

/** An element of a snapshot's tree, as agent-desktop gives it. */
export type DesktopNode = {
  role?: string
  name?: string
  value?: unknown
  description?: string
  placeholder?: string
  states?: string[]
  available_actions?: string[]
  ref_id?: string
  children_count?: number
  bounds?: { x?: number; y?: number; width?: number; height?: number }
  children?: DesktopNode[]
}

const TEXT_MAX = 160
/** The most of a tree a tool gives back: past it, the teammate narrows the snapshot. */
export const TREE_MAX = 40_000

const short = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > TEXT_MAX ? `${one.slice(0, TEXT_MAX)}…` : one
}

/** Actions shown as the act tool names them (Click → click, RightClick → right_click). */
const actionName = (action: string) =>
  action
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/\s+/g, '_')
    .toLowerCase()

/** One line for an element: role, name, value, states, ref and what it can do. */
function line(node: DesktopNode) {
  const parts = [node.role || 'element']
  if (node.name) parts.push(JSON.stringify(short(node.name)))
  if (node.value !== undefined && node.value !== null && node.value !== '')
    parts.push(`= ${JSON.stringify(short(String(node.value)))}`)
  if (node.placeholder) parts.push(`placeholder ${JSON.stringify(short(node.placeholder))}`)
  if (node.description && node.description !== node.name) parts.push(`(${short(node.description)})`)
  const states = (node.states ?? []).filter((state) => state !== 'hidden')
  if (states.length) parts.push(`[${states.join(', ')}]`)
  if (node.ref_id) parts.push(node.ref_id)
  const actions = (node.available_actions ?? []).map(actionName)
  if (node.ref_id && actions.length) parts.push(`{${actions.join(', ')}}`)
  if (node.bounds && node.bounds.width !== undefined)
    parts.push(
      `<${Math.round(node.bounds.x ?? 0)},${Math.round(node.bounds.y ?? 0)} ${Math.round(node.bounds.width)}×${Math.round(node.bounds.height ?? 0)}>`,
    )
  if (node.children_count && !node.children?.length) parts.push(`(${node.children_count} inside)`)
  return parts.join(' ')
}

/**
 * A snapshot's tree as indented text, an element a line: far fewer tokens than its JSON, which
 * repeats every key. Elements hidden from the person (states: hidden) are left out with what
 * they hold, unless `hidden`. Past `max` characters it stops, and says how many it left out.
 */
export function renderTree(
  tree: DesktopNode | undefined,
  options: { hidden?: boolean; max?: number } = {},
) {
  const max = options.max ?? TREE_MAX
  const lines: string[] = []
  let size = 0
  let left = 0
  let hiddenLeft = 0
  const walk = (node: DesktopNode, depth: number) => {
    if (!options.hidden && node.states?.includes('hidden')) {
      hiddenLeft++
      return
    }
    const text = `${'  '.repeat(depth)}${line(node)}`
    if (size + text.length + 1 > max) left++
    else {
      lines.push(text)
      size += text.length + 1
    }
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  if (tree) walk(tree, 0)
  return { text: lines.join('\n'), left, hidden: hiddenLeft }
}

/** Arguments that pick the app and window a command is about. */
export function targetArgs(input: { app?: string; window?: string }) {
  return [
    ...(input.app ? ['--app', input.app] : []),
    ...(input.window ? ['--window-id', input.window] : []),
  ]
}

/** Quote for a POSIX shell, as one word. */
export const shellQuote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`
