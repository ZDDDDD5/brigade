// The mouse and keyboard on an X11 session, through the XTEST extension (as xdotool does), over
// the `x11` package's pure JavaScript client: nothing to install on the person's computer.
// Coordinates come in screen points (the screenshots' units) and are turned into the X screen's
// pixels with the desktop's scale.
import x11 from 'x11'
import { buttonNumber, charKeysym, modifierKeysym, parseCombo } from './keys.js'
import type { Input, Point } from './input.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type XClient = {
  GetKeyboardMapping: (
    start: number,
    count: number,
    cb: (err: Error | null, rows: number[][]) => void,
  ) => void
  ChangeKeyboardMapping: (first: number, perKeycode: number, keysyms: number[]) => void
  GetInputFocus: (cb: (err: Error | null) => void) => void
  require: (name: string, cb: (err: Error | null, ext: XTest) => void) => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
  terminate: () => void
}
type XTest = {
  FakeInput: (
    type: number,
    detail: number,
    time: number,
    window: number,
    x: number,
    y: number,
  ) => void
  KeyPress: number
  KeyRelease: number
  ButtonPress: number
  ButtonRelease: number
  MotionNotify: number
}

export class X11Input implements Input {
  private constructor(
    private readonly client: XClient,
    private readonly xtest: XTest,
    private readonly root: number,
    private readonly minKeycode: number,
    private readonly maxKeycode: number,
    /** Screen pixels per point. */
    private readonly scale: () => number,
  ) {}

  static connect(scale: () => number, display = process.env.DISPLAY): Promise<X11Input> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The X display did not answer in time')),
        5000,
      )
      try {
        const client = x11.createClient({ display }, (error: Error | null, connection: any) => {
          if (error) {
            clearTimeout(timer)
            return reject(error)
          }
          const X = connection.client as XClient
          X.on('error', () => undefined)
          X.require('xtest', (err, xtest) => {
            clearTimeout(timer)
            if (err || !xtest)
              return reject(
                new Error('The X display has no XTEST extension, so input cannot be sent'),
              )
            resolve(
              new X11Input(
                X,
                xtest,
                connection.screen[0].root,
                connection.min_keycode,
                connection.max_keycode,
                scale,
              ),
            )
          })
        })
        client.on?.('error', (error: Error) => {
          clearTimeout(timer)
          reject(error)
        })
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  /** A round trip: what was sent before has reached the server. */
  private sync() {
    return new Promise<void>((resolve, reject) =>
      this.client.GetInputFocus((err) => (err ? reject(err) : resolve())),
    )
  }

  private mapping() {
    return new Promise<number[][]>((resolve, reject) =>
      this.client.GetKeyboardMapping(
        this.minKeycode,
        this.maxKeycode - this.minKeycode + 1,
        (err, rows) => (err ? reject(err) : resolve(rows)),
      ),
    )
  }

  private pixel(p: Point) {
    const s = this.scale()
    return { x: Math.round(p.x * s), y: Math.round(p.y * s) }
  }

  private fake(type: number, detail: number, x = 0, y = 0) {
    this.xtest.FakeInput(type, detail, 0, type === this.xtest.MotionNotify ? this.root : 0, x, y)
  }

  async move(p: Point) {
    const { x, y } = this.pixel(p)
    this.fake(this.xtest.MotionNotify, 0, x, y)
    await this.sync()
    await sleep(20)
  }

  async click(p: Point, button: string, count: number, modifiers: string[]) {
    const number = buttonNumber(button)
    const held = await this.keycodes(modifiers.map(modifierKeysym))
    await this.move(p)
    for (const code of held) this.fake(this.xtest.KeyPress, code)
    for (let i = 0; i < Math.max(1, Math.min(count, 3)); i++) {
      this.fake(this.xtest.ButtonPress, number)
      this.fake(this.xtest.ButtonRelease, number)
      await this.sync()
      await sleep(50)
    }
    for (const code of [...held].reverse()) this.fake(this.xtest.KeyRelease, code)
    await this.sync()
  }

  async drag(from: Point, to: Point) {
    await this.move(from)
    this.fake(this.xtest.ButtonPress, 1)
    await this.sync()
    await sleep(50)
    const steps = 12
    for (let step = 1; step <= steps; step++) {
      const t = step / steps
      const { x, y } = this.pixel({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      })
      this.fake(this.xtest.MotionNotify, 0, x, y)
      await this.sync()
      await sleep(15)
    }
    this.fake(this.xtest.ButtonRelease, 1)
    await this.sync()
    await sleep(20)
  }

  async scroll(p: Point, direction: string, amount: number) {
    const button = { up: 4, down: 5, left: 6, right: 7 }[direction]
    if (!button)
      throw Object.assign(new Error(`unsupported scroll direction ${direction}`), {
        code: 'invalid_argument',
      })
    await this.move(p)
    for (let i = 0; i < Math.max(1, Math.min(amount, 50)); i++) {
      this.fake(this.xtest.ButtonPress, button)
      this.fake(this.xtest.ButtonRelease, button)
    }
    await this.sync()
    await sleep(20)
  }

  /**
   * Keycodes for keysyms: where the layout has one, its key (and whether it needs Shift); else a
   * spare keycode, mapped to the keysym for the time of the call, as xdotool does.
   */
  private async plan(keysyms: number[]) {
    const rows = await this.mapping()
    const found = new Map<number, { code: number; shift: boolean }>()
    const missing: number[] = []
    for (const keysym of keysyms) {
      if (found.has(keysym) || missing.includes(keysym)) continue
      let hit: { code: number; shift: boolean } | undefined
      rows.forEach((row, i) => {
        if (hit) return
        if (row[0] === keysym) hit = { code: this.minKeycode + i, shift: false }
        else if (row[1] === keysym) hit = { code: this.minKeycode + i, shift: true }
      })
      if (hit) found.set(keysym, hit)
      else missing.push(keysym)
    }
    // Keycodes with no keysym at all, from the top: those xdotool borrows too.
    const spare: number[] = []
    for (let i = rows.length - 1; i >= 0 && spare.length < missing.length; i--)
      if (rows[i]!.every((keysym) => keysym === 0)) spare.push(this.minKeycode + i)
    return { rows, found, missing, spare, perKeycode: rows[0]?.length ?? 2 }
  }

  private async keycodes(keysyms: number[]) {
    const { found } = await this.plan(keysyms)
    return keysyms.map((keysym) => {
      const hit = found.get(keysym)
      if (!hit) throw new Error(`No key of this keyboard layout sends ${keysym.toString(16)}`)
      return hit.code
    })
  }

  async type(text: string) {
    const chars = [...text]
    const keysyms = chars.map(charKeysym)
    const plan = await this.plan(keysyms)
    const shift = (await this.keycodes([0xffe1]))[0]!
    // Characters the layout lacks go on spare keycodes, a batch at a time.
    const borrowed = new Map<number, number>()
    const restore = () => {
      for (const code of borrowed.values())
        this.client.ChangeKeyboardMapping(code, plan.perKeycode, new Array(plan.perKeycode).fill(0))
      borrowed.clear()
    }
    try {
      for (const keysym of keysyms) {
        let target = plan.found.get(keysym)
        if (!target) {
          let code = borrowed.get(keysym)
          if (code === undefined) {
            if (borrowed.size >= plan.spare.length) {
              restore()
              await this.sync()
            }
            code = plan.spare[borrowed.size]
            if (code === undefined)
              throw new Error('This keyboard layout has no spare key to type that character with')
            this.client.ChangeKeyboardMapping(
              code,
              plan.perKeycode,
              new Array(plan.perKeycode).fill(keysym),
            )
            borrowed.set(keysym, code)
            await this.sync()
            // Clients read the new mapping on MappingNotify before the key arrives.
            await sleep(30)
          }
          target = { code, shift: false }
        }
        if (target.shift) this.fake(this.xtest.KeyPress, shift)
        this.fake(this.xtest.KeyPress, target.code)
        this.fake(this.xtest.KeyRelease, target.code)
        if (target.shift) this.fake(this.xtest.KeyRelease, shift)
        await this.sync()
        await sleep(8)
      }
    } finally {
      if (borrowed.size) {
        await sleep(30)
        restore()
        await this.sync().catch(() => undefined)
      }
    }
  }

  async key(combo: string) {
    const { modifiers, key } = parseCombo(combo)
    const plan = await this.plan([...modifiers, key])
    const modifierCodes = modifiers.map((keysym) => {
      const hit = plan.found.get(keysym)
      if (!hit)
        throw new Error(`This keyboard layout has no key for modifier ${keysym.toString(16)}`)
      return hit.code
    })
    let target = plan.found.get(key)
    let borrowed: number | undefined
    if (!target) {
      borrowed = plan.spare[0]
      if (borrowed === undefined) throw new Error(`No key of this keyboard layout sends ${combo}`)
      this.client.ChangeKeyboardMapping(
        borrowed,
        plan.perKeycode,
        new Array(plan.perKeycode).fill(key),
      )
      await this.sync()
      await sleep(30)
      target = { code: borrowed, shift: false }
    }
    // A shifted character ("?") needs Shift unless the combination holds it already.
    const shift =
      target.shift && !modifiers.includes(0xffe1) ? (await this.keycodes([0xffe1]))[0] : undefined
    const held = [...modifierCodes, ...(shift ? [shift] : [])]
    try {
      for (const code of held) this.fake(this.xtest.KeyPress, code)
      this.fake(this.xtest.KeyPress, target.code)
      this.fake(this.xtest.KeyRelease, target.code)
      for (const code of [...held].reverse()) this.fake(this.xtest.KeyRelease, code)
      await this.sync()
      await sleep(20)
    } finally {
      if (borrowed !== undefined) {
        await sleep(30)
        this.client.ChangeKeyboardMapping(
          borrowed,
          plan.perKeycode,
          new Array(plan.perKeycode).fill(0),
        )
        await this.sync().catch(() => undefined)
      }
    }
  }

  /** Every keysym the layout types (any level). */
  async keysyms() {
    return new Set((await this.mapping()).flat().filter((keysym) => keysym !== 0))
  }

  close() {
    try {
      this.client.terminate()
    } catch {}
  }
}

/**
 * The keysyms the keyboard layout types, read from the X server (XWayland mirrors the Wayland
 * session's layout); undefined when there is none to ask.
 */
export async function layoutKeysyms(
  display = process.env.DISPLAY,
): Promise<Set<number> | undefined> {
  if (!display) return undefined
  let input: X11Input | undefined
  try {
    input = await X11Input.connect(() => 1, display)
    return await input.keysyms()
  } catch {
    return undefined
  } finally {
    input?.close()
  }
}
