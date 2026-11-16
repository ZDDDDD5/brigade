// Computer use on Linux, end to end: starts the packaged Brigade.app in a desktop session and
// asks it what the runner asks Brigade Computer Use (apps/runner/src/computer-use.ts), on the
// same socket, then checks the effects on real apps (GNOME Calculator and Text Editor).
//   node test/e2e/linux-computer-use.mjs <Brigade executable> <agent-desktop binary>
// Run it inside a desktop session (DISPLAY or WAYLAND_DISPLAY, a session bus with AT-SPI), with
// gnome-calculator and gnome-text-editor installed; on X11, xdotool presses the pill's Stop as the
// person would.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [executable, agentDesktop] = process.argv.slice(2)
assert.ok(executable && agentDesktop, 'usage: linux-computer-use.mjs <executable> <agent-desktop>')
const wayland = !!process.env.WAYLAND_DISPLAY
const home = process.env.HOME
const dir = join(home, '.brigade', 'computer-use')
const work = mkdtempSync(join(tmpdir(), 'brigade-cu-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
/** Screenshots to look at after a failure, when E2E_SHOTS names a folder. */
const shot = async (name) => {
  if (!process.env.E2E_SHOTS) return
  await request('screenshot', {
    path: join(process.env.E2E_SHOTS, `${wayland ? 'wayland' : 'x11'}-${name}.png`),
  }).catch(() => undefined)
}
const step = async (name, fn) => {
  const started = Date.now()
  try {
    await fn()
    results.push(`ok   ${name} (${Date.now() - started} ms)`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message}`)
  }
  console.log(results.at(-1))
}

const app = spawn(executable, ['--no-sandbox'], {
  env: { ...process.env, BRIGADE_DESKTOP_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

let nextId = 1
function request(method, params = {}, session = 'turn-1', wait = 90_000) {
  const token = readFileSync(join(dir, 'token'), 'utf8').trim()
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(dir, 'sock'))
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`${method}: no answer`))
    }, wait)
    socket.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify({
          id: nextId++,
          token,
          method,
          params: { ...params, agentDesktop, session: { id: session, label: 'Riley' } },
        })}\n`,
      ),
    )
    socket.on('data', (d) => {
      buffer += d
      const at = buffer.indexOf('\n')
      if (at < 0) return
      clearTimeout(timer)
      socket.destroy()
      const reply = JSON.parse(buffer.slice(0, at))
      if (reply.ok) resolve(reply.result)
      else
        reject(
          Object.assign(new Error(`${reply.error.code}: ${reply.error.message}`), {
            code: reply.error.code,
          }),
        )
    })
  })
}

const ad = (...args) => JSON.parse(execFileSync(agentDesktop, args, { encoding: 'utf8' }))

/** An element's middle, from computer_ui_tree's `role "name" [x,y w×h]` lines. */
function middleOf(tree, role, name) {
  const line = tree
    .split('\n')
    .find((l) => l.trim().startsWith(`${role} "${name}"`) && l.includes('['))
  assert.ok(line, `no ${role} "${name}" with a frame in the tree`)
  const [, x, y, w, h] = /\[(-?\d+),(-?\d+) (\d+)×(\d+)\]/.exec(line)
  return { x: Number(x) + Number(w) / 2, y: Number(y) + Number(h) / 2 }
}

/** The pill's X11 window, as xdotool finds it: x, y, width, height. */
function pill() {
  try {
    const ids = execFileSync('xdotool', ['search', '--onlyvisible', '--name', '^Brigade$'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean)
    for (const id of ids) {
      const geometry = execFileSync('xdotool', ['getwindowgeometry', '--shell', id], {
        encoding: 'utf8',
      })
      const v = Object.fromEntries(
        geometry
          .trim()
          .split('\n')
          .map((l) => l.split('=')),
      )
      if (Number(v.HEIGHT) <= 40) return { x: +v.X, y: +v.Y, width: +v.WIDTH, height: +v.HEIGHT }
    }
  } catch {}
  return undefined
}

try {
  await step('Brigade.app listens on the socket', async () => {
    if (app.exitCode !== null)
      throw new Error(`Brigade.app quit (${app.exitCode}): ${appLog.slice(-2000)}`)
    for (let i = 0; i < 300 && !existsSync(join(dir, 'sock')); i++) await sleep(200)
    assert.ok(existsSync(join(dir, 'sock')), `no socket. App log:\n${appLog.slice(-2000)}`)
    assert.equal(statSync(join(dir, 'token')).mode & 0o777, 0o600)
    assert.equal(readFileSync(join(dir, 'app'), 'utf8'), process.env.APPIMAGE || executable)
  })
  if (results.at(-1).startsWith('FAIL')) throw new Error('Brigade.app is not serving computer use')

  await step('status', async () => {
    const status = await request('status')
    console.log('     ', JSON.stringify(status))
    assert.equal(status.version, '3')
    assert.equal(status.platform, 'linux')
    assert.equal(status.accessibility, true)
    assert.equal(status.session, wayland ? 'wayland' : 'x11')
    assert.equal(status.input, wayland ? 'mutter' : 'xtest')
  })

  await step('a wrong token is refused', async () => {
    const reply = await new Promise((resolve) => {
      const socket = createConnection(join(dir, 'sock'))
      socket.on('connect', () => socket.write('{"id":1,"token":"nope","method":"status"}\n'))
      socket.on('data', (d) => {
        socket.destroy()
        resolve(JSON.parse(String(d)))
      })
    })
    assert.equal(reply.error.code, 'unauthorized')
  })

  await step('open_app opens Calculator', async () => {
    const opened = await request('open_app', { app: 'gnome-calculator' })
    console.log('     ', JSON.stringify(opened))
    assert.ok(opened.pid > 0)
    await sleep(1500)
  })

  await step('apps lists it', async () => {
    const { apps } = await request('apps')
    console.log('     ', JSON.stringify(apps))
    assert.ok(apps.some((a) => a.name === 'gnome-calculator'))
  })

  let tree = ''
  await step('ui_tree reads its buttons', async () => {
    const answer = await request('ui_tree', {
      app: 'gnome-calculator',
      maxNodes: 2000,
      maxDepth: 30,
    })
    tree = answer.tree
    assert.ok(answer.nodes > 10)
    assert.match(tree, /button "7"/)
    console.log(
      '     ',
      tree
        .split('\n')
        .filter((l) => /button "[78+=]"/.test(l))
        .join(' | '),
    )
  })

  await step('the pill shows while a teammate acts', async () => {
    await request('move', { x: 5, y: 5 })
    await sleep(800)
    const shown = pill()
    assert.ok(shown, 'no pill window on screen')
    assert.ok(shown.y < 60, `the pill is at ${shown.y}, not at the top`)
  })

  await step('screenshot: the display in points, without the pill', async () => {
    const path = join(work, 'images', 'shot.png')
    const shot = await request('screenshot', { path, display: 0 })
    console.log('     ', JSON.stringify(shot))
    const png = readFileSync(path)
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    assert.equal(png.readUInt32BE(16), shot.width)
    assert.equal(png.readUInt32BE(20), shot.height)
    assert.deepEqual(shot.origin, { x: 0, y: 0 })
    assert.equal(shot.displays, 1)
    // Set up Brigade's Screenshots step shows done from now on.
    assert.equal((await request('status')).screenRecording, true)
    // The pill is on the screen (X's own capture of the root window, with xwd) but not in the
    // screenshot: ImageMagick reads the same pixel of both.
    const shown = wayland ? undefined : pill()
    if (shown) {
      const root = join(work, 'root.png')
      execFileSync('bash', ['-c', `xwd -root -silent | convert xwd:- ${root}`])
      const at = `1x1+${shown.x + 60}+${shown.y + 4}`
      const read = (file) =>
        execFileSync('convert', [file, '-crop', at, '-format', '%[fx:int(255*r)]', 'info:'], {
          encoding: 'utf8',
        }).trim()
      assert.ok(Number(read(root)) < 90, `no dark pill at ${at} on the screen (${read(root)})`)
      assert.notEqual(read(path), read(root), 'the pill is in the screenshot')
    }
  })

  if (!wayland)
    await step('click: 7 + 8 = in Calculator by coordinates gives 15', async () => {
      for (const key of ['7', '+', '8', '=']) {
        await request('click', middleOf(tree, 'button', key))
        await sleep(150)
      }
      await sleep(400)
      const after = await request('ui_tree', {
        app: 'gnome-calculator',
        maxNodes: 2000,
        maxDepth: 30,
      })
      assert.match(after.tree, /15/, 'no 15 in Calculator after the clicks')
    })

  await step('key: Escape clears Calculator, keys type into it', async () => {
    // Wayland gives no running app the focus from outside: a new window takes it.
    if (wayland) {
      try {
        ad('close-app', 'gnome-calculator', '--force')
      } catch {}
      await sleep(500)
      await request('open_app', { app: 'gnome-calculator' })
      await sleep(1500)
    }
    await shot('calculator-clicked')
    await request('key', { key: 'escape' })
    for (const key of ['4', 'shift+8', '5', 'return']) await request('key', { key })
    await sleep(400)
    await shot('calculator-keys')
    const after = await request('ui_tree', {
      app: 'gnome-calculator',
      maxNodes: 2000,
      maxDepth: 30,
    })
    assert.match(after.tree, /20/, 'no 20 (4×5) in Calculator after the keys')
  })

  await step('key for an app not in front is refused', async () => {
    await assert.rejects(
      request('key', { key: 'a', app: 'gnome-text-editor' }),
      /not_front|not in front/,
    )
  })

  await step('type: Unicode text into Text Editor', async () => {
    await request('open_app', { app: 'gnome-text-editor' })
    await sleep(2500)
    if (wayland) {
      await request('click', { x: 640, y: 420 })
      await sleep(300)
    }
    const text = 'Hello wörld €½ – ok'
    await request('type', { text })
    await sleep(600)
    await shot('editor-typed')
    const found = ad('find', '--app', 'gnome-text-editor', '--role', 'textarea')
    const snap = JSON.stringify(ad('snapshot', '--app', 'gnome-text-editor', '--max-depth', '40'))
    assert.ok(
      snap.includes(text) || JSON.stringify(found).includes(text),
      `the editor does not show "${text}"`,
    )
  })

  await step('key with the app in front: ctrl+a, BackSpace empties the editor', async () => {
    await request('key', { key: 'ctrl+a', app: 'gnome-text-editor' })
    await request('key', { key: 'BackSpace', app: 'gnome-text-editor' })
    await sleep(500)
    const snap = JSON.stringify(ad('snapshot', '--app', 'gnome-text-editor', '--max-depth', '40'))
    assert.ok(!snap.includes('Hello wörld'), 'the text is still there')
  })

  if (!wayland)
    await step('scroll and drag are sent', async () => {
      await request('scroll', { x: 400, y: 300, direction: 'down', amount: 3 })
      await request('drag', { fromX: 300, fromY: 300, toX: 350, toY: 320 })
    })

  await step('run: output and exit code, in the session', async () => {
    const result = await request('run', {
      command: 'echo "display=${DISPLAY:-}${WAYLAND_DISPLAY:-}"; echo err >&2; exit 3',
      cwd: work,
      env: { EXTRA: '1' },
    })
    console.log('     ', JSON.stringify(result))
    assert.equal(result.exitCode, 3)
    assert.match(result.output, /display=\S+/)
    assert.match(result.output, /err/)
  })

  await step('run: a timeout stops the command and what it left', async () => {
    const result = await request('run', { command: 'sleep 60 & sleep 60', timeout: 1 })
    assert.equal(result.timedOut, true)
    await sleep(500)
    let left = ''
    try {
      left = execFileSync('pgrep', ['-f', '^sleep 60$'], { encoding: 'utf8' }).trim()
    } catch {}
    assert.equal(left, '', 'a sleep it started in the background is still running')
  })

  await step('another turn waits while one acts', async () => {
    await request('move', { x: 6, y: 6 }, 'turn-1')
    await assert.rejects(request('move', { x: 7, y: 7 }, 'turn-2'), /busy/)
  })

  if (!wayland)
    await step("Stop on the pill stops the turn's command, and the turn", async () => {
      const running = request('run', { command: 'sleep 30', timeout: 60 }, 'turn-1')
      await sleep(1500)
      const shown = pill()
      assert.ok(shown, 'no pill to press')
      // As the person: the pointer on Stop, at the pill's right end.
      execFileSync('xdotool', [
        'mousemove',
        String(shown.x + shown.width - 30),
        String(shown.y + shown.height / 2),
        'click',
        '1',
      ])
      await assert.rejects(running, /stopped/)
      await assert.rejects(request('move', { x: 8, y: 8 }, 'turn-1'), /stopped/)
      // Another turn may use the computer.
      await request('move', { x: 9, y: 9 }, 'turn-3')
    })

  await step('cancel ends a turn', async () => {
    await request('cancel', {}, wayland ? 'turn-1' : 'turn-3')
    const result = await request('run', { command: 'echo after', cwd: work }, 'turn-4')
    assert.match(result.output, /after/)
  })
} finally {
  app.kill('SIGTERM')
  await sleep(1500)
  if (app.exitCode === null) app.kill('SIGKILL')
}
console.log('\n' + results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL'))
if (failed.length) console.log(`\n${failed.length} failed. App log (end):\n${appLog.slice(-3000)}`)
// Chromium's helper processes may keep the app's output open: done is done.
process.exit(failed.length ? 1 : 0)
