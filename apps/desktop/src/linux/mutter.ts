// The mouse and keyboard on a GNOME Wayland session, through Mutter's own RemoteDesktop API (as
// GNOME's remote desktop server uses it): Wayland lets no other app send input, and the desktop
// portal's equivalent asks the person on every start. While a session is open, GNOME shows its
// screen-sharing icon in the top bar, whose Stop ends it: that counts as the person pressing Stop.
// Points are the layout's (logical) coordinates; each monitor is a stream that the pointer is
// placed in.
import { Bus, DBusError, variant } from './dbus.js'
import { buttonNumber, charKeysym, modifierKeysym, parseCombo } from './keys.js'
import { monitorAt, type Check, type Input, type Monitor, type Point } from './input.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const RD = 'org.gnome.Mutter.RemoteDesktop'
const SC = 'org.gnome.Mutter.ScreenCast'
const DC = 'org.gnome.Mutter.DisplayConfig'

/** evdev codes: BTN_LEFT, BTN_RIGHT, BTN_MIDDLE. */
const EVDEV: Record<number, number> = { 1: 0x110, 2: 0x112, 3: 0x111 }

/** A session is closed this long after its last input, which takes GNOME's icon away. */
const IDLE_MS = 20_000

type LogicalMonitor = [
  number,
  number,
  number,
  number,
  boolean,
  [string, string, string, string][],
  unknown,
]
type PhysicalMonitor = [
  [string, string, string, string],
  [string, number, number, number, number, number[], Record<string, unknown>][],
  Record<string, unknown>,
]

/** The monitors as Mutter lays them out: in its layout's coordinates, the primary first. */
export function mutterMonitors(state: unknown[]): Monitor[] {
  const [, physical, logical, properties] = state as [
    number,
    PhysicalMonitor[],
    LogicalMonitor[],
    Record<string, unknown>,
  ]
  // 1: logical (sizes are the mode's divided by the scale), 2: physical.
  const logicalLayout = Number(properties['layout-mode'] ?? 1) === 1
  const monitors: Monitor[] = []
  for (const [x, y, scale, transform, primary, specs] of logical) {
    const connector = specs[0]?.[0]
    if (!connector) continue
    const physicalMonitor = physical.find(([spec]) => spec[0] === connector)
    const mode = physicalMonitor?.[1].find((m) => m[6]['is-current'] === true)
    if (!mode) continue
    // 90° and 270° (and their flipped forms) turn the monitor on its side.
    const sideways = transform % 2 === 1
    let width = sideways ? mode[2] : mode[1]
    let height = sideways ? mode[1] : mode[2]
    if (logicalLayout) {
      width = Math.round(width / scale)
      height = Math.round(height / scale)
    }
    monitors.push({
      id: connector,
      x,
      y,
      width,
      height,
      // Pixels per layout unit: the scale in a logical layout, 1 in a physical one.
      scale: logicalLayout ? scale : 1,
      primary,
    })
  }
  return monitors.sort((a, b) => Number(b.primary) - Number(a.primary))
}

export async function readMutterMonitors(bus: Bus) {
  const state = await bus.call({
    destination: DC,
    path: '/org/gnome/Mutter/DisplayConfig',
    interface: DC,
    member: 'GetCurrentState',
  })
  return mutterMonitors(state)
}

/** Whether this session is GNOME on Wayland with Mutter's RemoteDesktop. */
export async function hasMutterRemoteDesktop(bus: Bus) {
  try {
    await bus.property(RD, '/org/gnome/Mutter/RemoteDesktop', RD, 'Version')
    return true
  } catch {
    return false
  }
}

type Session = {
  path: string
  /** Each monitor's stream, by connector. */
  streams: Map<string, string>
  monitors: Monitor[]
}

export class MutterInput implements Input {
  private session: Promise<Session> | undefined
  private idle: NodeJS.Timeout | undefined
  /** A session we closed ourselves: its Closed signal is not the person's Stop. */
  private closing = new Set<string>()

  constructor(
    private readonly bus: Bus,
    /** The person ended the session from GNOME's own indicator. */
    private readonly onClosedByPerson: () => void,
    /** The keysyms the session's layout has, when they can be read (from XWayland). */
    private readonly readLayout: () => Promise<Set<number> | undefined> = async () => undefined,
  ) {
    bus.on('signal', (signal: { path: string; interface: string; member: string }) => {
      if (signal.interface !== `${RD}.Session` || signal.member !== 'Closed') return
      void this.session?.then(
        (session) => {
          if (session.path !== signal.path) return
          this.session = undefined
          if (this.closing.delete(signal.path)) return
          this.onClosedByPerson()
        },
        () => undefined,
      )
    })
  }

  private open(): Promise<Session> {
    this.session ??= this.start().catch((error: unknown) => {
      this.session = undefined
      throw error
    })
    return this.session
  }

  private async start(): Promise<Session> {
    await this.bus.match(`type='signal',interface='${RD}.Session'`)
    await this.bus.match(`type='signal',interface='${SC}.Stream'`)
    try {
      return await this.createSession(true)
    } catch (error) {
      // Without GNOME's screen cast (PipeWire not running), the keyboard still works: the
      // pointer, which is placed in a monitor's stream, does not.
      const session = await this.createSession(false).catch(() => undefined)
      if (!session) throw error
      this.pointerError = `GNOME's screen cast is not available (${(error as Error).message}), so the pointer can't be moved`
      return session
    }
  }

  /** Why the pointer can't be placed in this session, when it can't. */
  private pointerError: string | undefined

  private async createSession(withStreams: boolean): Promise<Session> {
    const [path] = (await this.bus.call({
      destination: RD,
      path: '/org/gnome/Mutter/RemoteDesktop',
      interface: RD,
      member: 'CreateSession',
    })) as [string]
    try {
      const streams = new Map<string, string>()
      const monitors = await readMutterMonitors(this.bus)
      if (withStreams) {
        const id = await this.bus.property(RD, path, `${RD}.Session`, 'SessionId')
        const [castPath] = (await this.bus.call({
          destination: SC,
          path: '/org/gnome/Mutter/ScreenCast',
          interface: SC,
          member: 'CreateSession',
          signature: 'a{sv}',
          body: [{ 'remote-desktop-session-id': variant('s', id) }],
        })) as [string]
        for (const monitor of monitors) {
          const [stream] = (await this.bus.call({
            destination: SC,
            path: castPath,
            interface: `${SC}.Session`,
            member: 'RecordMonitor',
            signature: 'sa{sv}',
            body: [monitor.id, { 'cursor-mode': variant('u', 0) }],
          })) as [string]
          streams.set(monitor.id, stream)
        }
      }
      // The pointer can be placed in a stream once it has started.
      const started = new Set<string>()
      const allStarted = new Promise<void>((resolve) => {
        if (!streams.size) return resolve()
        const listener = (signal: { path: string; interface: string; member: string }) => {
          if (signal.interface !== `${SC}.Stream` || signal.member !== 'PipeWireStreamAdded') return
          started.add(signal.path)
          if ([...streams.values()].every((s) => started.has(s))) {
            this.bus.off('signal', listener)
            resolve()
          }
        }
        this.bus.on('signal', listener)
        setTimeout(() => {
          this.bus.off('signal', listener)
          resolve()
        }, 3000)
      })
      await this.bus.call({ destination: RD, path, interface: `${RD}.Session`, member: 'Start' })
      await allStarted
      if (withStreams) this.pointerError = undefined
      return { path, streams, monitors }
    } catch (error) {
      await this.stopSession(path)
      throw error
    }
  }

  private async stopSession(path: string) {
    this.closing.add(path)
    await this.bus
      .call({ destination: RD, path, interface: `${RD}.Session`, member: 'Stop' })
      .catch(() => this.closing.delete(path))
  }

  /** The session, kept for IDLE_MS after this call. */
  private async use() {
    clearTimeout(this.idle)
    const session = await this.open()
    this.idle = setTimeout(() => void this.close(), IDLE_MS)
    return session
  }

  private async notify(member: string, signature: string, body: unknown[]) {
    const session = await this.use()
    try {
      await this.bus.call({
        destination: RD,
        path: session.path,
        interface: `${RD}.Session`,
        member,
        signature,
        body,
      })
    } catch (error) {
      // The session went away under us (the person stopped it, the monitors changed): the
      // next call opens a new one.
      if (error instanceof DBusError) this.session = undefined
      throw error
    }
  }

  private async place(p: Point) {
    const session = await this.use()
    if (!session.streams.size)
      throw new Error(
        this.pointerError ?? "GNOME's screen cast is not available, so the pointer can't be moved",
      )
    const monitor = monitorAt(session.monitors, p)
    if (!monitor)
      throw Object.assign(new Error(`${p.x},${p.y} is on no display`), { code: 'invalid_argument' })
    const stream = session.streams.get(monitor.id)!
    await this.notify('NotifyPointerMotionAbsolute', 'sdd', [
      stream,
      (p.x - monitor.x) * monitor.scale,
      (p.y - monitor.y) * monitor.scale,
    ])
  }

  private keysym(keysym: number, pressed: boolean) {
    return this.notify('NotifyKeyboardKeysym', 'ub', [keysym, pressed])
  }

  private button(number: number, pressed: boolean) {
    return this.notify('NotifyPointerButton', 'ib', [EVDEV[number]!, pressed])
  }

  async move(p: Point) {
    await this.place(p)
    await sleep(20)
  }

  async click(p: Point, button: string, count: number, modifiers: string[], check?: Check) {
    const number = buttonNumber(button)
    const held = modifiers.map(modifierKeysym)
    await this.place(p)
    await sleep(20)
    for (const keysym of held) await this.keysym(keysym, true)
    try {
      for (let i = 0; i < Math.max(1, Math.min(count, 3)); i++) {
        check?.()
        await this.button(number, true)
        await this.button(number, false)
        await sleep(50)
      }
    } finally {
      for (const keysym of [...held].reverse()) await this.keysym(keysym, false)
    }
  }

  async drag(from: Point, to: Point, check?: Check) {
    await this.place(from)
    check?.()
    await this.button(1, true)
    try {
      await sleep(50)
      const steps = 12
      for (let step = 1; step <= steps; step++) {
        check?.()
        const t = step / steps
        await this.place({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
        await sleep(15)
      }
    } finally {
      await this.button(1, false)
    }
  }

  async scroll(p: Point, direction: string, amount: number) {
    const axis = { up: [0, -1], down: [0, 1], left: [1, -1], right: [1, 1] }[direction]
    if (!axis)
      throw Object.assign(new Error(`unsupported scroll direction ${direction}`), {
        code: 'invalid_argument',
      })
    await this.place(p)
    await this.notify('NotifyPointerAxisDiscrete', 'ui', [
      axis[0],
      axis[1]! * Math.max(1, Math.min(amount, 50)),
    ])
  }

  /**
   * Mutter types only the keysyms the session's layout has, and drops the others without a word
   * ("wörld" came out "wrld"): those go in through the toolkit's Unicode entry, Ctrl+Shift+U, the
   * code and Space, which GTK and IBus (so Chromium, Electron and Qt on GNOME) take.
   */
  async type(text: string, check?: Check) {
    // Read each time: the person may have switched layouts since.
    const has = await this.readLayout()
    for (const char of text) {
      check?.()
      const keysym = charKeysym(char)
      // Return, Tab and the like are in every layout.
      const typable = has
        ? has.has(keysym) || (keysym >= 0xff00 && keysym <= 0xffff)
        : char.charCodeAt(0) < 0x80
      if (typable) {
        await this.keysym(keysym, true)
        await this.keysym(keysym, false)
      } else await this.unicode(char.codePointAt(0)!)
      await sleep(8)
    }
  }

  private async unicode(code: number) {
    await this.keysym(0xffe3, true) // Control_L
    await this.keysym(0xffe1, true) // Shift_L
    await this.keysym(0x75, true) // u
    await this.keysym(0x75, false)
    await this.keysym(0xffe1, false)
    await this.keysym(0xffe3, false)
    await sleep(20)
    for (const digit of code.toString(16)) {
      const keysym = digit.charCodeAt(0)
      await this.keysym(keysym, true)
      await this.keysym(keysym, false)
    }
    await this.keysym(0x20, true)
    await this.keysym(0x20, false)
    await sleep(20)
  }

  async key(combo: string) {
    const { modifiers, key } = parseCombo(combo)
    for (const keysym of modifiers) await this.keysym(keysym, true)
    try {
      await this.keysym(key, true)
      await this.keysym(key, false)
    } finally {
      for (const keysym of [...modifiers].reverse()) await this.keysym(keysym, false)
    }
    await sleep(20)
  }

  /** Ends the session: GNOME's screen-sharing icon goes. */
  async close() {
    clearTimeout(this.idle)
    const session = this.session
    this.session = undefined
    if (!session) return
    const opened = await session.catch(() => undefined)
    if (opened) await this.stopSession(opened.path)
  }
}
