// Brigade Computer Use on Linux, inside Brigade.app: the same socket, token and requests as the
// macOS helper app (apps/computer-use-macos), so the runner's computer_* tools work the same on a
// member's Linux computer (apps/runner/src/computer-use.ts). Linux asks no permission for most of
// it: the screen on X11, the accessibility tree (AT-SPI) everywhere. On Wayland, screenshots go
// through the desktop portal, which asks the person once, and the pointer and keyboard through
// GNOME's RemoteDesktop (other Wayland desktops let no app send input).
//
// The mouse and keyboard: XTEST on X11 (x11-input.ts), Mutter on GNOME Wayland (mutter.ts).
// Screenshots: Chromium's own capturer on X11, the portal on Wayland, in screen points. Apps and
// their interface: agent-desktop, the runner's copy (it sends its path with each request).
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { desktopCapturer, nativeImage, screen } from 'electron'
import { Bus } from './dbus.js'
import { Indicator } from './indicator.js'
import { cropOf, monitorAt, sessionType, type Input, type Monitor } from './input.js'
import { hasMutterRemoteDesktop, MutterInput, readMutterMonitors } from './mutter.js'
import { portalScreenshot, PortalError } from './portal.js'
import { environment, runCommand, shutdown as stopCommand } from './run.js'
import { InputLine } from './input-line.js'
import { HelperError, Sessions } from './sessions.js'
import { layoutKeysyms, X11Input } from './x11-input.js'

/** The protocol's version: 3 checks a named app is in front as it sends a key. */
export const VERSION = '3'

export const computerUseDir = () => join(process.env.HOME || homedir(), '.brigade', 'computer-use')

type Params = Record<string, unknown>

const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function point(params: Params, x = 'x', y = 'y') {
  const px = number(params[x])
  const py = number(params[y])
  if (px === undefined || py === undefined)
    throw new HelperError('invalid_argument', `${x} and ${y} are required`)
  return { x: px, y: py }
}

function absolutePath(params: Params) {
  const path = params.path
  if (typeof path !== 'string' || !path.startsWith('/'))
    throw new HelperError('invalid_argument', 'an absolute path is required')
  return path
}

/** agent-desktop's answer: its data, or its error as the helper's. */
type DesktopAnswer = {
  ok?: boolean
  data?: unknown
  error?: { code?: string; message?: string; suggestion?: string }
}

export class LinuxComputerUse {
  readonly sessions: Sessions
  readonly indicator: Indicator
  private bus: Promise<Bus> | undefined
  private input: Promise<Input> | undefined
  /** The mouse and keyboard, one action at a time (input-line.ts). */
  private readonly line: InputLine
  private screenshotsAllowed = false

  constructor() {
    this.indicator = new Indicator(() => this.sessions.stop())
    this.sessions = new Sessions(this.indicator)
    this.line = new InputLine(this.sessions, () => this.inputs())
  }

  readonly session = sessionType()

  private sessionBus() {
    this.bus ??= Bus.connect().then((bus) => {
      bus.on('close', () => {
        this.bus = undefined
        this.input = undefined
      })
      return bus
    })
    this.bus.catch(() => (this.bus = undefined))
    return this.bus
  }

  /** The mouse and keyboard of this session. */
  private inputs() {
    this.input ??= (async (): Promise<Input> => {
      if (this.session === 'x11') return X11Input.connect(() => this.x11Scale())
      if (this.session === 'wayland') {
        const bus = await this.sessionBus()
        if (await hasMutterRemoteDesktop(bus))
          // GNOME's own Stop on its screen-sharing icon is the person's Stop.
          return new MutterInput(
            bus,
            () => this.sessions.stop(),
            () => layoutKeysyms(),
          )
        throw new HelperError(
          'not_supported',
          'This Wayland desktop lets no app move the pointer or type (only GNOME does, through its ' +
            'remote desktop). Use computer_snapshot and computer_act, which work through ' +
            'accessibility, or ask the person to log in to an X11 or GNOME session.',
        )
      }
      throw new HelperError('not_supported', 'Brigade runs in no graphical session here')
    })()
    this.input.catch(() => (this.input = undefined))
    return this.input
  }

  /** X11 has one scale for the whole screen: pixels per point. */
  private x11Scale() {
    return screen.getPrimaryDisplay().scaleFactor || 1
  }

  /** The displays, the primary first, in screen points. */
  async monitors(): Promise<Monitor[]> {
    if (this.session === 'wayland') {
      const bus = await this.sessionBus().catch(() => undefined)
      if (bus && (await hasMutterRemoteDesktop(bus))) return readMutterMonitors(bus)
    }
    const primary = screen.getPrimaryDisplay().id
    return screen
      .getAllDisplays()
      .map((d) => ({
        id: String(d.id),
        ...d.bounds,
        scale: d.scaleFactor || 1,
        primary: d.id === primary,
      }))
      .sort((a, b) => Number(b.primary) - Number(a.primary))
  }

  /** A display's PNG, in screen points, without the pill. */
  private async capture(index: number) {
    const monitors = await this.monitors()
    const monitor = monitors[index]
    if (!monitor)
      throw new HelperError(
        'invalid_argument',
        `display ${index} does not exist; there are ${monitors.length}`,
      )
    const image = await this.indicator.aside(async () => {
      if (this.session === 'wayland') {
        const png = await portalScreenshot(await this.sessionBus()).catch((error: unknown) => {
          if (error instanceof PortalError) throw new HelperError(error.code, error.message)
          throw error
        })
        this.allowScreenshots()
        const whole = nativeImage.createFromBuffer(png!)
        return whole.crop(cropOf(monitors, monitor, whole.getSize().width))
      }
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(monitor.width * monitor.scale),
          height: Math.round(monitor.height * monitor.scale),
        },
      })
      const source =
        sources.find((s) => s.display_id === monitor.id) ?? sources[index] ?? sources[0]
      if (!source || source.thumbnail.isEmpty())
        throw new HelperError('failed', 'The screen could not be captured')
      return source.thumbnail
    })
    // In points, not pixels: smaller for the model, and the same units as clicks.
    const resized =
      image.getSize().width === monitor.width
        ? image
        : image.resize({ width: monitor.width, height: monitor.height, quality: 'best' })
    return { png: resized.toPNG(), monitor, monitors }
  }

  private allowScreenshots() {
    if (this.screenshotsAllowed) return
    this.screenshotsAllowed = true
    try {
      writeFileSync(join(computerUseDir(), 'screenshots-allowed'), '')
    } catch {}
  }

  private screenshotsKnownAllowed() {
    return (
      this.session !== 'wayland' ||
      this.screenshotsAllowed ||
      existsSync(join(computerUseDir(), 'screenshots-allowed'))
    )
  }

  /** Whether the accessibility bus answers: apps' interfaces can be read. */
  async accessibility() {
    try {
      const bus = await this.sessionBus()
      await bus.call(
        {
          destination: 'org.a11y.Bus',
          path: '/org/a11y/bus',
          interface: 'org.a11y.Bus',
          member: 'GetAddress',
        },
        3000,
      )
      return true
    } catch {
      return false
    }
  }

  async status() {
    let input = 'none'
    if (this.session === 'x11') input = 'xtest'
    else if (this.session === 'wayland') {
      const bus = await this.sessionBus().catch(() => undefined)
      if (bus && (await hasMutterRemoteDesktop(bus))) input = 'mutter'
    }
    return {
      version: VERSION,
      platform: 'linux',
      session: this.session ?? 'none',
      input,
      screenRecording: this.screenshotsKnownAllowed(),
      accessibility: await this.accessibility(),
    }
  }

  /** The desktop asks the person to allow screenshots (Wayland), from Set up Brigade. */
  async askForScreenshots() {
    if (this.session !== 'wayland') return true
    await this.capture(0)
    return true
  }

  /** agent-desktop, run as the person in their session. */
  private desktop(params: Params, args: string[], timeoutMs = 30_000) {
    const binary = params.agentDesktop
    if (
      typeof binary !== 'string' ||
      !isAbsolute(binary) ||
      !basename(binary).startsWith('agent-desktop') ||
      !existsSync(binary)
    )
      throw new HelperError(
        'not_installed',
        'agent-desktop is missing from this runner: use computer_screenshot and computer_click meanwhile.',
      )
    return new Promise<unknown>((resolve, reject) => {
      execFile(
        binary,
        args,
        { env: environment({}), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout) => {
          let answer: DesktopAnswer
          try {
            answer = JSON.parse(stdout)
          } catch {
            return reject(
              new HelperError('failed', `agent-desktop gave no answer: ${error?.message ?? ''}`),
            )
          }
          if (answer.ok) return resolve(answer.data)
          const code = answer.error?.code ?? 'failed'
          reject(
            new HelperError(
              code === 'APP_NOT_FOUND' ? 'app_not_found' : 'failed',
              [answer.error?.message, answer.error?.suggestion].filter(Boolean).join('. ') ||
                'It failed.',
            ),
          )
        },
      )
    })
  }

  private async windows(params: Params) {
    return ((await this.desktop(params, ['list-windows'])) ?? []) as {
      app_name?: string
      pid?: number
      is_focused?: boolean
      title?: string
    }[]
  }

  async apps(params: Params) {
    const [listed, windows] = await Promise.all([
      this.desktop(params, ['list-apps']) as Promise<{
        apps?: { name?: string; bundle_id?: string; pid?: number; presentation?: string }[]
      }>,
      this.windows(params).catch(() => []),
    ])
    const focused = windows.find((w) => w.is_focused)?.pid
    return {
      apps: (listed.apps ?? [])
        .filter((a) => a.presentation !== 'background')
        .map((a) => ({
          name: a.name ?? '',
          bundleId: a.bundle_id ?? '',
          pid: a.pid ?? 0,
          active: !!focused && a.pid === focused,
          hidden: false,
        })),
    }
  }

  /** The app in front, as `apps` lists it. */
  private async front(params: Params) {
    return (await this.apps(params)).apps.find((a) => a.active)
  }

  async openApp(params: Params, app: string) {
    const data = (await this.desktop(params, ['launch', app, '--activate'], 40_000)) as {
      app?: string
      pid?: number
      window?: { is_focused?: boolean }
    }
    const listed = (await this.apps(params).catch(() => ({ apps: [] }))).apps.find(
      (a) => a.pid === data.pid,
    )
    return {
      name: data.app ?? app,
      bundleId: listed?.bundleId ?? '',
      pid: data.pid ?? 0,
      active: data.window?.is_focused ?? listed?.active ?? false,
    }
  }

  /** The app's windows as indented lines, as on a Mac: `button "Save" [x,y w×h]`. */
  async uiTree(params: Params) {
    const app =
      typeof params.app === 'string' && params.app ? params.app : (await this.front(params))?.name
    if (!app) throw new HelperError('app_not_found', 'no app is in front')
    const maxDepth = Math.min(number(params.maxDepth) ?? 12, 50)
    const maxNodes = number(params.maxNodes) ?? 400
    const data = (await this.desktop(params, [
      'snapshot',
      '--app',
      app,
      '--max-depth',
      String(maxDepth),
      '--include-bounds',
      ...(params.menus ? ['--surface', 'menubar'] : []),
    ])) as { app?: string; tree?: TreeNode }
    const lines: string[] = []
    let count = 0
    let truncated = false
    const visit = (node: TreeNode, depth: number) => {
      if (count >= maxNodes) {
        truncated = true
        return
      }
      count++
      lines.push('  '.repeat(depth) + describe(node))
      for (const child of node.children ?? []) visit(child, depth + 1)
    }
    if (data.tree) visit(data.tree, 0)
    const pid =
      (await this.apps(params).catch(() => ({ apps: [] }))).apps.find((a) => a.name === app)?.pid ??
      0
    return { app: data.app ?? app, pid, tree: lines.join('\n'), nodes: count, truncated }
  }

  /** One request, as the macOS helper answers it (main.swift's handler). */
  async handle(method: string, params: Params): Promise<unknown> {
    if (method === 'status') return this.status()
    // The person's own screenshot, from Brigade.app: no teammate turn behind it.
    if (method === 'capture') return this.interactiveCapture(absolutePath(params))
    if (method === 'cancel') {
      const id = (params.session as { id?: unknown } | undefined)?.id
      if (typeof id !== 'string') throw new HelperError('invalid_request', 'session.id is required')
      this.sessions.cancel(id)
      return { ok: true }
    }
    const id = this.sessions.begin(params.session)
    switch (method) {
      case 'screenshot': {
        const path = absolutePath(params)
        const index = number(params.display) ?? 0
        const { png, monitor, monitors } = await this.capture(index)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, png)
        return {
          path,
          width: monitor.width,
          height: monitor.height,
          origin: { x: monitor.x, y: monitor.y },
          display: index,
          displays: monitors.length,
        }
      }
      case 'move':
        await this.line.run(id, (input) => input.move(point(params)))
        return { ok: true }
      case 'click':
        await this.line.run(id, (input, check) =>
          input.click(
            point(params),
            typeof params.button === 'string' ? params.button : 'left',
            number(params.count) ?? 1,
            Array.isArray(params.modifiers) ? params.modifiers.map(String) : [],
            check,
          ),
        )
        return { ok: true }
      case 'drag':
        await this.line.run(id, (input, check) =>
          input.drag(point(params, 'fromX', 'fromY'), point(params, 'toX', 'toY'), check),
        )
        return { ok: true }
      case 'scroll':
        await this.line.run(id, (input) =>
          input.scroll(
            point(params),
            typeof params.direction === 'string' ? params.direction : 'down',
            number(params.amount) ?? 5,
          ),
        )
        return { ok: true }
      case 'type': {
        const text = params.text
        if (typeof text !== 'string') throw new HelperError('invalid_argument', 'text is required')
        await this.line.run(id, (input, check) => input.type(text, check))
        return { ok: true }
      }
      case 'key': {
        const key = params.key
        if (typeof key !== 'string') throw new HelperError('invalid_argument', 'key is required')
        // For a named app: sent only if it is in front at this moment, checked and sent with no
        // other input in between.
        const app = typeof params.app === 'string' && params.app ? params.app : undefined
        return this.line.run(id, async (input, check) => {
          if (!app) {
            await input.key(key)
            return { ok: true }
          }
          const wanted = app.toLowerCase().replace(/\.desktop$/, '')
          const front = await this.front(params)
          if (!front || ![front.name, front.bundleId].some((n) => n.toLowerCase() === wanted))
            throw new HelperError(
              'not_front',
              `${app} is not in front (${front?.name ?? 'another app'} is), so nothing was sent`,
            )
          check()
          await input.key(key)
          return { ok: true, to: front.name }
        })
      }
      case 'apps':
        return this.apps(params)
      case 'open_app': {
        if (typeof params.app !== 'string' || !params.app)
          throw new HelperError('invalid_argument', 'app is required')
        return this.openApp(params, params.app)
      }
      case 'ui_tree':
        return this.uiTree(params)
      case 'run': {
        if (typeof params.command !== 'string' || !params.command)
          throw new HelperError('invalid_argument', 'command is required')
        return runCommand({
          command: params.command,
          ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}),
          env: Object.fromEntries(
            Object.entries((params.env as Record<string, unknown>) ?? {}).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
          ...(number(params.timeout) !== undefined ? { timeout: number(params.timeout)! } : {}),
          hold: () => this.sessions.hold(id),
        })
      }
      default:
        throw new HelperError('unknown_method', `unknown method ${method}`)
    }
  }

  /** Brigade.app's screenshot shortcut: the desktop's own selection, else the screen under the
   * pointer. */
  async interactiveCapture(path: string) {
    await mkdir(dirname(path), { recursive: true })
    const bus = await this.sessionBus().catch(() => undefined)
    if (bus) {
      try {
        const png = await portalScreenshot(bus, { interactive: true, timeoutMs: 120_000 })
        if (!png) return { cancelled: true }
        await writeFile(path, png)
        return { path }
      } catch (error) {
        if (!(error instanceof PortalError) || error.code !== 'not_supported') {
          if (error instanceof PortalError) throw new HelperError(error.code, error.message)
          throw error
        }
      }
    }
    if (this.session !== 'x11')
      throw new HelperError('not_supported', 'This desktop has no screenshot portal')
    const monitors = await this.monitors()
    const cursor = screen.getCursorScreenPoint()
    const index = Math.max(0, monitors.indexOf(monitorAt(monitors, cursor) ?? monitors[0]!))
    const { png } = await this.capture(index)
    await writeFile(path, png)
    return { path }
  }

  async close() {
    stopCommand()
    this.indicator.quit()
    const input = await this.input?.catch(() => undefined)
    await input?.close()
    ;(await this.bus?.catch(() => undefined))?.close()
  }
}

type TreeNode = {
  role?: string
  name?: string
  description?: string
  value?: unknown
  states?: string[]
  bounds?: { x: number; y: number; width: number; height: number }
  children?: TreeNode[]
}

function describe(node: TreeNode) {
  const clip = (text: string) => (text.length > 120 ? `${text.slice(0, 120)}…` : text)
  const parts = [node.role ?? '?']
  const title = node.name || node.description
  if (title) parts.push(`"${clip(title.trim())}"`)
  if (node.value !== undefined && node.value !== null && String(node.value).trim())
    parts.push(`value="${clip(String(node.value).trim())}"`)
  if (node.states?.includes('disabled')) parts.push('disabled')
  if (node.states?.includes('focused')) parts.push('focused')
  const b = node.bounds
  if (b)
    parts.push(
      `[${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}]`,
    )
  return parts.join(' ')
}

/**
 * The socket the runner talks to: one JSON object per line each way, as the macOS helper's.
 * Request: {"id": 1, "token": "...", "method": "click", "params": {...}}
 * Reply:   {"id": 1, "ok": true, "result": {...}} or {"id": 1, "ok": false, "error": {code, message}}
 */
export function serve(computer: LinuxComputerUse, executable: string): Server {
  const dir = computerUseDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const token = randomBytes(32).toString('hex')
  const tokenFile = join(dir, 'token')
  rmSync(tokenFile, { force: true })
  writeFileSync(tokenFile, token, { mode: 0o600 })
  // Where the runner finds Brigade.app to start it, when it isn't running.
  writeFileSync(join(dir, 'app'), executable, { mode: 0o600 })
  const sock = join(dir, 'sock')
  rmSync(sock, { force: true })
  const server = createServer((socket: Socket) => {
    let buffer = ''
    let queue = Promise.resolve()
    socket.setEncoding('utf8')
    socket.on('error', () => undefined)
    socket.on('data', (data: string) => {
      buffer += data
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        queue = queue.then(async () => {
          const reply = await respond(computer, token, line)
          if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`)
        })
      }
    })
  })
  server.listen(sock, () => {
    try {
      chmodSync(sock, 0o600)
    } catch {}
  })
  return server
}

async function respond(computer: LinuxComputerUse, token: string, line: string) {
  let request: { id?: unknown; token?: unknown; method?: unknown; params?: unknown }
  try {
    request = JSON.parse(line)
    if (!request || typeof request !== 'object') throw new Error()
  } catch {
    return failure(null, new HelperError('invalid_request', 'not a JSON object'))
  }
  const id = request.id ?? null
  if (request.token !== token) return failure(id, new HelperError('unauthorized', 'wrong token'))
  if (typeof request.method !== 'string')
    return failure(id, new HelperError('invalid_request', 'method is required'))
  try {
    const result = await computer.handle(request.method, (request.params as Params) ?? {})
    return { id, ok: true, result }
  } catch (error) {
    return failure(
      id,
      error instanceof HelperError
        ? error
        : new HelperError(
            (error as { code?: string }).code === 'invalid_argument'
              ? 'invalid_argument'
              : 'failed',
            error instanceof Error ? error.message : String(error),
          ),
    )
  }
}

function failure(id: unknown, error: HelperError) {
  return { id, ok: false, error: { code: error.code, message: error.message } }
}
