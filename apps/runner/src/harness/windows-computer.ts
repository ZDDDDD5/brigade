// Computer use on a member's Windows PC: agent-desktop (../agent-desktop.ts), run by the runner
// itself. Brigade.app starts the runner in the person's session, so it reaches their desktop
// through UI Automation with no permission to ask for, unlike a Mac (Brigade Computer Use.app).
// The tools are the Mac's: computer_snapshot and computer_act on refs (desktop-tools.ts), and
// the screen ones (tools.ts's computerUseTools), whose requests this answers as the Mac's helper
// would, with agent-desktop's screenshot, mouse and keyboard commands.
import { spawn } from 'node:child_process'
import { type DesktopExec } from '../agent-desktop.js'
import { ComputerUseError } from '../computer-use.js'
import { harnessEnv } from './env.js'
import type { ComputerUse } from './tools.js'

/** How long one agent-desktop command may run, in ms. */
const TIMEOUT_MS = 90_000

/** agent-desktop run here, its text on stdin (never on its command line). */
export function localDesktopExec(binary: (signal?: AbortSignal) => Promise<string>): DesktopExec {
  return async (args, options = {}) => {
    // Stopped already, or while the binary was found: the action never starts.
    if (options.signal?.aborted) throw new Error('aborted')
    const path = await binary(options.signal)
    if (options.signal?.aborted) throw new Error('aborted')
    return new Promise<string>((resolve, reject) => {
      const child = spawn(path, args, {
        stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: harnessEnv(),
      })
      let out = ''
      let err = ''
      child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')))
      child.stderr!.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-4000)))
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
      const abort = () => child.kill()
      options.signal?.addEventListener('abort', abort, { once: true })
      child.once('error', reject)
      child.once('close', (code) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (options.signal?.aborted) return reject(new Error('aborted'))
        // agent-desktop answers with an envelope whatever happened; nothing means it did not run.
        if (out.trim()) return resolve(out)
        reject(
          new Error(
            `agent-desktop gave no answer (exit ${code})${err.trim() ? `: ${err.trim().slice(-1000)}` : ''}`,
          ),
        )
      })
      if (options.stdin !== undefined) {
        child.stdin!.on('error', () => undefined)
        child.stdin!.end(options.stdin)
      }
    })
  }
}

type Envelope = {
  ok?: boolean
  data?: unknown
  error?: { code?: string; message?: string }
}

/** One agent-desktop command's data, or its error as Brigade Computer Use would give it. */
async function command(exec: DesktopExec, args: string[], signal?: AbortSignal) {
  const out = await exec(args, signal ? { signal } : {})
  let envelope: Envelope
  try {
    envelope = JSON.parse(out.trim().split('\n').at(-1)!) as Envelope
  } catch {
    throw new ComputerUseError('failed', `agent-desktop answered: ${out.slice(0, 300)}`)
  }
  if (!envelope.ok)
    throw new ComputerUseError(
      (envelope.error?.code ?? 'failed').toLowerCase(),
      envelope.error?.message ?? 'agent-desktop failed',
    )
  return envelope.data
}

const xy = (x: unknown, y: unknown) => `--xy=${Math.round(Number(x))},${Math.round(Number(y))}`

/** The modifiers as agent-desktop takes them (cmd is ctrl on Windows). */
const modifiers = (list: unknown) =>
  (Array.isArray(list) ? (list as string[]) : []).flatMap((m) => [
    '--modifiers',
    m === 'cmd' ? 'ctrl' : m,
  ])

/** An app as Windows lists it (Notepad.exe) and as a person names it (Notepad). */
const sameApp = (listed: string | undefined, named: string) => {
  const bare = (name: string) => name.toLowerCase().replace(/\.exe$/, '')
  return !!listed && bare(listed) === bare(named)
}

/**
 * The Mac helper's requests (status, apps, screenshot, click, move, drag, scroll, key, type,
 * open_app), answered with agent-desktop on Windows. What a Mac does through its helper alone
 * (computer_run, computer_ui_tree) is not offered on Windows (computerUseTools).
 */
export function windowsComputer(
  exec: DesktopExec,
  base: Omit<ComputerUse, 'request'>,
): ComputerUse {
  const request = async (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    switch (method) {
      case 'status':
        // Version 3: it checks a named app is in front as it sends a key (computerUseTools).
        return { version: 3, platform: 'windows' }
      case 'apps': {
        const data = (await command(exec, ['list-apps'], signal)) as {
          apps?: { name?: string; pid?: number; presentation?: string }[]
        }
        // The window with the keyboard decides which app is in front.
        const windows = (await command(exec, ['list-windows'], signal).catch(() => [])) as {
          app_name?: string
          is_focused?: boolean
        }[]
        const front = (Array.isArray(windows) ? windows : []).find((w) => w.is_focused)?.app_name
        return {
          apps: (data.apps ?? []).map((app) => ({
            name: app.name?.replace(/\.exe$/i, ''),
            pid: app.pid,
            active: !!front && app.name === front,
          })),
        }
      }
      case 'screenshot': {
        const display = Number(params.display ?? 0)
        const shot = (await command(
          exec,
          ['screenshot', '--screen', String(display), String(params.path)],
          signal,
        )) as { width?: number; height?: number }
        const displays = (await command(exec, ['list-displays'], signal).catch(() => [])) as {
          bounds?: { x: number; y: number; width: number; height: number }
        }[]
        const bounds = Array.isArray(displays) ? displays[display]?.bounds : undefined
        return {
          width: shot.width,
          height: shot.height,
          origin: { x: bounds?.x ?? 0, y: bounds?.y ?? 0 },
          displays: Array.isArray(displays) ? displays.length : 1,
        }
      }
      case 'click':
        await command(
          exec,
          [
            'mouse-click',
            '--headed',
            xy(params.x, params.y),
            '--button',
            String(params.button ?? 'left'),
            '--count',
            String(params.count ?? 1),
            ...modifiers(params.modifiers),
          ],
          signal,
        )
        return { ok: true }
      case 'move':
        await command(exec, ['mouse-move', '--headed', xy(params.x, params.y)], signal)
        return { ok: true }
      case 'drag':
        await command(
          exec,
          [
            'drag',
            '--headed',
            `--from-xy=${Math.round(Number(params.fromX))},${Math.round(Number(params.fromY))}`,
            `--to-xy=${Math.round(Number(params.toX))},${Math.round(Number(params.toY))}`,
          ],
          signal,
        )
        return { ok: true }
      case 'scroll': {
        const amount = Number(params.amount ?? 5)
        const direction = String(params.direction)
        // Positive: up, or right.
        const delta = direction === 'up' || direction === 'right' ? amount : -amount
        await command(
          exec,
          [
            'mouse-wheel',
            '--headed',
            `--x=${Math.round(Number(params.x))}`,
            `--y=${Math.round(Number(params.y))}`,
            direction === 'left' || direction === 'right' ? `--dx=${delta}` : `--dy=${delta}`,
          ],
          signal,
        )
        return { ok: true }
      }
      case 'key': {
        const key = String(params.key).replace(/\bcmd\b/g, 'ctrl')
        if (typeof params.app === 'string') {
          // Sent only if the app is in front as it goes, as the Mac's helper does.
          const { apps } = (await request('apps', {}, signal)) as {
            apps: { name?: string; active?: boolean }[]
          }
          if (!apps.some((app) => app.active && sameApp(app.name, params.app as string)))
            throw new ComputerUseError('not_front', `${params.app} is not in front`)
        }
        await command(exec, ['press', '--headed', key], signal)
        return { ok: true }
      }
      case 'type':
        throw new ComputerUseError(
          'unsupported',
          'On Windows, type into a field by its ref (computer_act type or set_value), or name its app ' +
            '(computer_type with app): text goes into the field that has its focus',
        )
      case 'open_app': {
        const app = String(params.app)
        const launched = (await command(
          exec,
          ['launch', app, '--activate', '--timeout', '20000'],
          signal,
        )) as { app?: string; pid?: number }
        return {
          name: launched.app?.replace(/\.exe$/i, '') ?? app,
          pid: launched.pid,
          active: true,
        }
      }
      case 'cancel':
        return {}
      default:
        throw new ComputerUseError('unknown_method', `${method} is not offered on Windows`)
    }
  }
  return { ...base, request }
}
