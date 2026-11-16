// `run`: a shell command started for a teammate turn, while the pill shows its name with Stop,
// as Brigade Computer Use does on a Mac (Run.swift). Linux has no per-app permissions to lend, so
// what matters here is the rest: one command at a time, its end on Stop, an interrupted turn or its
// timeout, and the processes it left in its group stopped with it.
import { spawn } from 'node:child_process'
import { existsSync, openSync, closeSync, statSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir, userInfo, constants } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HelperError } from './sessions.js'

export const MAX_OUTPUT = 100_000
const DEFAULT_TIMEOUT = 120
const MAX_TIMEOUT = 1800

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The running command's process group, so that a quit can stop it. */
let running: number | undefined
let claimed = false

/** The person's basics and their graphical session's, then what the runner passes. */
export function environment(given: Record<string, string>, env = process.env) {
  const base: Record<string, string> = {
    HOME: homedir(),
    USER: userInfo().username,
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
    LANG: 'C.UTF-8',
  }
  for (const name of [
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'XDG_RUNTIME_DIR',
    'XDG_SESSION_TYPE',
    'XDG_CURRENT_DESKTOP',
    'XDG_DATA_DIRS',
    'DBUS_SESSION_BUS_ADDRESS',
    'LANG',
  ])
    if (env[name]) base[name] = env[name]!
  return { ...base, ...given }
}

function alive(group: number) {
  try {
    process.kill(-group, 0)
    return true
  } catch {
    return false
  }
}

function signal(group: number, sig: NodeJS.Signals) {
  try {
    process.kill(-group, sig)
  } catch {}
}

/** Stops a process group: SIGTERM, then SIGKILL for what is left 2 seconds later. */
async function sweep(group: number) {
  if (!alive(group)) return
  signal(group, 'SIGTERM')
  const until = Date.now() + 2000
  while (Date.now() < until) {
    await sleep(100)
    if (!alive(group)) return
  }
  for (let i = 0; i < 20 && alive(group); i++) {
    signal(group, 'SIGKILL')
    await sleep(50)
  }
}

/** The end of a file, where errors are: at most MAX_OUTPUT characters. */
async function tail(file: string) {
  const text = await readFile(file, 'utf8').catch(() => '')
  return text.length > MAX_OUTPUT
    ? { text: text.slice(text.length - MAX_OUTPUT), truncated: true }
    : { text, truncated: false }
}

export async function runCommand({
  command,
  cwd,
  env,
  timeout,
  hold,
}: {
  command: string
  cwd?: string
  env: Record<string, string>
  timeout?: number
  /** Every 2 seconds: false once the turn is stopped. */
  hold: () => boolean
}) {
  const directory = cwd ?? homedir()
  if (!directory.startsWith('/') || !existsSync(directory) || !statSync(directory).isDirectory())
    throw new HelperError(
      'invalid_argument',
      `cwd must be an existing absolute directory: ${directory}`,
    )
  const limit = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT, 1), MAX_TIMEOUT) * 1000
  if (claimed)
    throw new HelperError(
      'busy',
      'Another command is running through Brigade Computer Use. Wait for it to end, then try again.',
    )
  claimed = true
  // A file rather than a pipe: something the command leaves running can't keep the reply waiting.
  const output = join(tmpdir(), `brigade-run-${randomUUID()}.log`)
  try {
    const fd = openSync(output, 'w', 0o600)
    const shell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
    let child
    try {
      child = spawn(shell, ['-c', command], {
        cwd: directory,
        env: environment(env),
        // Its own process group (its pid), which is stopped as a whole.
        detached: true,
        stdio: ['ignore', fd, fd],
      })
    } finally {
      closeSync(fd)
    }
    const group = child.pid
    if (!group) throw new HelperError('failed', `could not start ${shell}`)
    running = group
    const started = Date.now()
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
    child.on('exit', (code, sig) => {
      exit = { code, signal: sig }
    })
    child.on('error', () => {
      exit ??= { code: 127, signal: null }
    })
    let ended: 'timeout' | 'stopped' | undefined
    let signalledAt = Infinity
    let heldAt = 0
    while (!exit) {
      if (!ended) {
        if (Date.now() - started > limit) ended = 'timeout'
        else if (Date.now() - heldAt >= 2000) {
          heldAt = Date.now()
          if (!hold()) ended = 'stopped'
        }
        if (ended) {
          signal(group, 'SIGTERM')
          signalledAt = Date.now()
        }
      } else if (Date.now() - signalledAt > 3000) signal(group, 'SIGKILL')
      // Most commands (agent-desktop's snapshots and actions) end within a second.
      await sleep(Date.now() - started < 2000 ? 10 : 200)
    }
    // What it left running in its group stops with it, before the reply.
    await sweep(group)
    const { text, truncated } = await tail(output)
    if (ended === 'stopped')
      throw new HelperError(
        'stopped',
        "The person pressed Stop on the computer-use indicator, which stopped the command. Don't use the computer again in this turn: say so, and wait for their next message.",
      )
    const result: Record<string, unknown> = {
      output: text,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    }
    const done = exit as { code: number | null; signal: NodeJS.Signals | null }
    if (done.signal) result.signal = constants.signals[done.signal] ?? done.signal
    else result.exitCode = done.code ?? 0
    if (truncated) result.truncated = true
    if (ended === 'timeout') result.timedOut = true
    return result
  } finally {
    running = undefined
    claimed = false
    await rm(output, { force: true })
  }
}

/** Before Brigade.app quits: the command running and what it left go first. */
export function shutdown() {
  if (running) signal(running, 'SIGKILL')
}
