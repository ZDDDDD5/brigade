import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeMessage,
  encodeMessage,
  sessionBusPath,
  splitSignature,
  variant,
} from '../src/linux/dbus.js'
import { cropOf, monitorAt } from '../src/linux/input.js'
import { charKeysym, keyKeysym, parseCombo } from '../src/linux/keys.js'
import { MutterInput, mutterMonitors } from '../src/linux/mutter.js'
import type { Bus } from '../src/linux/dbus.js'
import { InputLine } from '../src/linux/input-line.js'
import { Sessions } from '../src/linux/sessions.js'
import { X11Input } from '../src/linux/x11-input.js'

test('D-Bus signatures split into complete types', () => {
  assert.deepEqual(splitSignature('sa{sv}ii'), ['s', 'a{sv}', 'i', 'i'])
  assert.deepEqual(splitSignature('a(iiduba(ssss)a{sv})'), ['a(iiduba(ssss)a{sv})'])
  assert.throws(() => splitSignature('a{sv'))
})

test('a D-Bus message reads back as it was written', () => {
  const body = [
    'Meta-0',
    { 'cursor-mode': variant('u', 1), interactive: variant('b', true), name: variant('s', 'x') },
    [
      [0, 0, 1.5, 0, true, [['eDP-1', 'v', 'p', 's']], {}],
      [1920, 0, 1, 1, false, [['HDMI-1', 'v', 'p', 's']], { a: variant('i', -3) }],
    ],
    2.25,
  ]
  const encoded = encodeMessage({
    type: 1,
    serial: 7,
    path: '/org/gnome/Mutter/RemoteDesktop',
    interface: 'org.gnome.Mutter.RemoteDesktop',
    member: 'CreateSession',
    destination: 'org.gnome.Mutter.RemoteDesktop',
    signature: 'sa{sv}a(iiduba(ssss)a{sv})d',
    body,
  })
  // Body length in the header, and the header padded to 8.
  const decoded = decodeMessage(encoded)
  assert.ok(decoded)
  assert.equal(decoded.length, encoded.length)
  assert.equal(decoded.message.serial, 7)
  assert.equal(decoded.message.fields.get(3), 'CreateSession')
  assert.deepEqual(decoded.message.body, [
    'Meta-0',
    { 'cursor-mode': 1, interactive: true, name: 'x' },
    [
      [0, 0, 1.5, 0, true, [['eDP-1', 'v', 'p', 's']], {}],
      [1920, 0, 1, 1, false, [['HDMI-1', 'v', 'p', 's']], { a: -3 }],
    ],
    2.25,
  ])
  // Incomplete: nothing yet.
  assert.equal(decodeMessage(encoded.subarray(0, encoded.length - 1)), undefined)
})

test('the session bus address', () => {
  assert.equal(
    sessionBusPath({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }),
    '/run/user/1000/bus',
  )
  assert.equal(
    sessionBusPath({ DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-x,guid=12' }),
    '\0/tmp/dbus-x',
  )
  assert.equal(sessionBusPath({ XDG_RUNTIME_DIR: '/run/user/7' }), '/run/user/7/bus')
})

test('keys and combinations as keysyms', () => {
  assert.equal(keyKeysym('return'), 0xff0d)
  assert.equal(keyKeysym('Page_Up'), 0xff55)
  assert.equal(keyKeysym('f5'), 0xffc2)
  assert.equal(keyKeysym('a'), 0x61)
  assert.equal(charKeysym('é'), 0xe9)
  assert.equal(charKeysym('€'), 0x010020ac)
  assert.equal(charKeysym('\n'), 0xff0d)
  assert.deepEqual(parseCombo('ctrl+shift+t'), { modifiers: [0xffe3, 0xffe1], key: 0x74 })
  assert.deepEqual(parseCombo('cmd+n'), { modifiers: [0xffeb], key: 0x6e })
  // A bare capital is that letter with Shift; with other modifiers case is ignored.
  assert.deepEqual(parseCombo('H'), { modifiers: [0xffe1], key: 0x68 })
  assert.deepEqual(parseCombo('ctrl+A'), { modifiers: [0xffe3], key: 0x61 })
  assert.deepEqual(parseCombo('ctrl++'), { modifiers: [0xffe3], key: 0x2b })
  assert.throws(() => parseCombo('hyper+x'), /unsupported modifier/)
  assert.throws(() => parseCombo('nokey'), /unsupported key/)
})

test("Mutter's monitors in its layout's coordinates, the primary first", () => {
  const mode = (w: number, h: number) => [`${w}x${h}`, w, h, 60, 1, [1], { 'is-current': true }]
  const state = [
    1,
    [
      [['eDP-1', 'v', 'p', 's'], [mode(2880, 1800)], {}],
      [['HDMI-1', 'v', 'p', 's'], [mode(1920, 1080)], {}],
    ],
    [
      [1440, 0, 2, 0, true, [['eDP-1', 'v', 'p', 's']], {}],
      [0, 0, 1, 0, false, [['HDMI-1', 'v', 'p', 's']], {}],
    ],
    { 'layout-mode': 1 },
  ]
  const monitors = mutterMonitors(state)
  assert.deepEqual(monitors, [
    { id: 'eDP-1', x: 1440, y: 0, width: 1440, height: 900, scale: 2, primary: true },
    { id: 'HDMI-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: false },
  ])
  // A physical layout: sizes in pixels, and the stream's coordinates are the layout's.
  const physical = mutterMonitors([
    state[0],
    state[1],
    [(state[2] as unknown[])[0]],
    { 'layout-mode': 2 },
  ])
  assert.deepEqual(physical[0], {
    id: 'eDP-1',
    x: 1440,
    y: 0,
    width: 2880,
    height: 1800,
    scale: 1,
    primary: true,
  })
  assert.equal(monitorAt(monitors, { x: 1500, y: 10 })?.id, 'eDP-1')
  assert.equal(monitorAt(monitors, { x: 5000, y: 10 }), undefined)
})

test("a monitor's part of a whole-desktop screenshot", () => {
  const monitors = [
    { id: 'a', x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true },
    { id: 'b', x: 1920, y: 0, width: 1280, height: 800, scale: 1, primary: false },
  ]
  // The portal's image at 2 pixels a point.
  assert.deepEqual(cropOf(monitors, monitors[1]!, 6400), {
    x: 3840,
    y: 0,
    width: 2560,
    height: 1600,
  })
})

test('one teammate turn at a time, until the person presses Stop', () => {
  const shown: string[] = []
  let now = 0
  const sessions = new Sessions(
    { show: (text) => shown.push(text), hide: () => shown.push('hidden') },
    () => now,
  )
  assert.throws(() => sessions.begin({}), /session.id is required/)
  const id = sessions.begin({ id: 't1', label: 'Riley' })
  assert.equal(shown.at(-1), 'Riley is using your computer')
  assert.throws(() => sessions.begin({ id: 't2', label: 'Sam' }), /Riley is using this computer/)
  now += 16_000
  sessions.begin({ id: 't2', label: 'Sam' })
  assert.equal(sessions.hold(id), false)
  sessions.stop()
  assert.equal(shown.at(-1), 'hidden')
  assert.throws(() => sessions.begin({ id: 't2' }), /pressed Stop/)
  sessions.begin({ id: 't3' })
  sessions.cancel('t3')
  assert.equal(sessions.hold('t3'), false)
})

/** XTEST through a stand-in X connection: what was sent, in order. */
function fakeX11(onKey?: (count: number) => void, beforeKeymap?: () => Promise<void>) {
  let keys = 0
  let cursor: { x: number; y: number } | undefined
  const clicked: { x: number; y: number }[] = []
  const pressed = new Set<number>()
  const client = {
    GetKeyboardMapping: (_s: number, _c: number, cb: (e: null, rows: number[][]) => void) =>
      void (beforeKeymap?.() ?? Promise.resolve()).then(() =>
        cb(null, [
          [0x61, 0x41],
          [0xffe1, 0],
          [0xffe3, 0],
          [0, 0],
        ]),
      ),
    GetInputFocus: (cb: (e: null) => void) => setImmediate(() => cb(null)),
    ChangeKeyboardMapping: () => undefined,
  }
  const xtest = {
    KeyPress: 2,
    KeyRelease: 3,
    ButtonPress: 4,
    ButtonRelease: 5,
    MotionNotify: 6,
    FakeInput: (type: number, code: number, _t: number, _w: number, x: number, y: number) => {
      if (type === 6) cursor = { x, y }
      if (type === 4) {
        clicked.push(cursor!)
        pressed.add(-code)
      }
      if (type === 5) pressed.delete(-code)
      if (type === 2) pressed.add(code)
      if (type === 3) pressed.delete(code)
      if (type === 2 && code === 8) onKey?.(++keys)
    },
  }
  // The constructor is private: the stand-in goes in as connect() would put it.
  const input = new (X11Input as unknown as new (...args: unknown[]) => X11Input)(
    client,
    xtest,
    1,
    8,
    11,
    () => 1,
  )
  return { input, clicked, pressed, keys: () => keys }
}

test('Stop while typing sends no more keys, and releases what it held', async () => {
  const sessions = new Sessions({ show: () => undefined, hide: () => undefined })
  const x = fakeX11((count) => count === 5 && sessions.stop())
  const line = new InputLine(sessions, async () => x.input)
  const id = sessions.begin({ id: 'typing' })
  await assert.rejects(
    line.run(id, (input, check) => input.type('a'.repeat(100), check)),
    /pressed Stop/,
  )
  assert.equal(x.keys(), 5)
  assert.equal(x.pressed.size, 0)
  // And the next action of that turn sends nothing.
  await assert.rejects(
    line.run(id, (input) => input.key('a')),
    /pressed Stop/,
  )
  assert.equal(x.keys(), 5)
})

test('two clicks sent at once each land on their own point', async () => {
  const sessions = new Sessions({ show: () => undefined, hide: () => undefined })
  const x = fakeX11()
  const line = new InputLine(sessions, async () => x.input)
  const id = sessions.begin({ id: 'clicks' })
  await Promise.all([
    line.run(id, (input, check) => input.click({ x: 10, y: 10 }, 'left', 1, [], check)),
    line.run(id, (input, check) => input.click({ x: 200, y: 200 }, 'left', 1, [], check)),
  ])
  assert.deepEqual(x.clicked, [
    { x: 10, y: 10 },
    { x: 200, y: 200 },
  ])
})

test('a drag stopped midway lets go of the button', async () => {
  const sessions = new Sessions({ show: () => undefined, hide: () => undefined })
  const x = fakeX11()
  const line = new InputLine(sessions, async () => x.input)
  const id = sessions.begin({ id: 'drag' })
  setTimeout(() => sessions.stop(), 80)
  await assert.rejects(
    line.run(id, (input, check) => input.drag({ x: 0, y: 0 }, { x: 100, y: 100 }, check)),
    /pressed Stop/,
  )
  assert.equal(x.pressed.size, 0)
})

test('Stop while the input is starting sends nothing', async () => {
  const sessions = new Sessions({ show: () => undefined, hide: () => undefined })
  const x = fakeX11()
  let started!: () => void
  const line = new InputLine(
    sessions,
    () => new Promise((resolve) => (started = () => resolve(x.input))),
  )
  const id = sessions.begin({ id: 'starting' })
  const sent = line.run(id, (input) => input.key('a'))
  await new Promise((resolve) => setImmediate(resolve))
  sessions.stop()
  started()
  await assert.rejects(sent, /pressed Stop/)
  assert.equal(x.keys(), 0)
})

test('Stop while the keymap is read sends no key, and nothing stays pressed', async () => {
  const sessions = new Sessions({ show: () => undefined, hide: () => undefined })
  const x = fakeX11(undefined, async () => {
    sessions.stop()
  })
  const line = new InputLine(sessions, async () => x.input)
  const id = sessions.begin({ id: 'keymap' })
  await assert.rejects(
    line.run(id, (input) => input.key('ctrl+a')),
    /pressed Stop/,
  )
  assert.equal(x.keys(), 0)
  assert.equal(x.pressed.size, 0)
})

test('on GNOME Wayland, Stop while the session opens sends no key, and releases a held modifier', async () => {
  const sessions = new Sessions({ show: () => undefined, hide: () => undefined })
  const calls: { member: string; body: unknown[] }[] = []
  let opened!: () => void
  const opening = new Promise<void>((resolve) => (opened = resolve))
  const bus = {
    on: () => undefined,
    off: () => undefined,
    match: async () => undefined,
    property: async () => 'id',
    call: async ({ member, body }: { member: string; body?: unknown[] }) => {
      calls.push({ member, body: body ?? [] })
      if (member === 'CreateSession') {
        await opening
        return ['/session']
      }
      if (member === 'GetCurrentState') return [1, [], [], { 'layout-mode': 1 }]
      return []
    },
  } as unknown as Bus
  const input = new MutterInput(bus, () => undefined)
  const line = new InputLine(sessions, async () => input)
  const id = sessions.begin({ id: 'wayland' })
  const sent = line.run(id, (i) => i.key('a'))
  await new Promise((resolve) => setImmediate(resolve))
  sessions.stop()
  opened()
  await assert.rejects(sent, /pressed Stop/)
  const keys = calls.filter((c) => c.member === 'NotifyKeyboardKeysym')
  assert.deepEqual(keys, [])

  // A modifier pressed, then Stop before the key: the modifier is let go.
  const sessions2 = new Sessions({ show: () => undefined, hide: () => undefined })
  const line2 = new InputLine(sessions2, async () => input)
  const id2 = sessions2.begin({ id: 'wayland2' })
  const before = calls.length
  const realCall = bus.call.bind(bus)
  ;(bus as unknown as { call: typeof bus.call }).call = async (c) => {
    const answer = await realCall(c)
    if (c.member === 'NotifyKeyboardKeysym' && (c.body as unknown[])[1] === true) sessions2.stop()
    return answer
  }
  await assert.rejects(
    line2.run(id2, (i) => i.key('ctrl+a')),
    /pressed Stop/,
  )
  const sent2 = calls.slice(before).filter((c) => c.member === 'NotifyKeyboardKeysym')
  assert.deepEqual(
    sent2.map((c) => c.body),
    [
      [0xffe3, true],
      [0xffe3, false],
    ],
  )
  await input.close()
})
