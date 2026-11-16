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
import { mutterMonitors } from '../src/linux/mutter.js'
import { Sessions } from '../src/linux/sessions.js'

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
