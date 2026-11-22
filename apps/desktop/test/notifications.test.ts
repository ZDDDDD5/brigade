// The app's own notifications (src/notifications.ts), with Electron, the settings file and the
// network stood in: what a fetch still in flight may do once the person turned them off, signed
// out or turned them on for another account, and that turning off never waits long.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const source = stripTypeScriptTypes(
  readFileSync(new URL('../src/notifications.ts', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*?from .*\n/gm, '')
    .replace(/^export /gm, ''),
)

type Fetch = (url: string, init: { method?: string; signal?: AbortSignal }) => Promise<unknown>
type Api = {
  fetchNow: () => Promise<void>
  disable: () => Promise<string | undefined>
  enable: (device: { api: string; deviceId: string; token: string }) => void
  device: () => { deviceId: string } | undefined
}

function app(fetch: Fetch) {
  // The device's file, in memory.
  const files = new Map<string, string>([
    [
      '/home/notifications.json',
      JSON.stringify({ api: 'https://api.example', deviceId: 'old', token: 'old-token' }),
    ],
  ])
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const timers = new Set<object>()
  const shown: { title: string }[] = []
  class Notification {
    static isSupported = () => true
    constructor(readonly options: { title: string }) {}
    on() {}
    close() {}
    show() {
      shown.push(this.options)
    }
  }
  const context = vm.createContext({
    fetch,
    AbortSignal,
    AbortController,
    URL,
    Buffer,
    Notification,
    app: { setBadgeCount() {} },
    home: () => '/home',
    join: (...parts: string[]) => parts.join('/'),
    readFileSync: (path: string) => {
      if (!files.has(path)) throw missing()
      return files.get(path)!
    },
    writeFileSync: (path: string, data: string) => void files.set(path, data),
    renameSync: (from: string, to: string) => {
      files.set(to, files.get(from)!)
      files.delete(from)
    },
    rmSync: (path: string) => void files.delete(path),
    mkdirSync() {},
    chmodSync() {},
    process: { pid: 1 },
    allowedDashboard: () => true,
    dashboard: () => 'https://dashboard.example/app',
    showDashboard() {},
    setInterval: () => {
      const t = {}
      timers.add(t)
      return t
    },
    clearInterval: (t: object) => timers.delete(t),
  })
  vm.runInContext(`${source}; globalThis.api = { fetchNow, disable, enable, device }`, context)
  return { api: (context as { api: Api }).api, shown, timers }
}

const private_ = { title: 'Sam has a question', body: 'Confidential', tag: 't1', url: '/app' }
const answer = (messages: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ messages }),
})

test('a fetch in flight when turned off (or signing out) shows nothing', async () => {
  let respond!: (value: unknown) => void
  const { api, shown } = app((_url, init) =>
    init.method === 'DELETE' ? Promise.resolve({ ok: true }) : new Promise((r) => (respond = r)),
  )
  const poll = api.fetchNow()
  assert.equal(await api.disable(), 'old')
  respond(answer([private_]))
  await poll
  assert.deepEqual(shown, [])
})

test("the previous device's 401 leaves the new one fetching", async () => {
  const responses: ((value: unknown) => void)[] = []
  const { api, shown, timers } = app(() => new Promise((r) => responses.push(r)))
  const old = api.fetchNow()
  api.enable({ api: 'https://api.example', deviceId: 'new', token: 'new-token' })
  // Turned on: "Notifications are on", and the new device's own fetch started.
  assert.equal(shown.length, 1)
  assert.equal(responses.length, 2)
  responses[0]!({ ok: false, status: 401 })
  await old
  assert.equal(api.device()?.deviceId, 'new')
  assert.equal(timers.size, 1)
  responses[1]!(answer([private_]))
  await new Promise((r) => setImmediate(r))
  assert.equal(shown.at(-1)!.title, 'Sam has a question')
})

test('turning off waits a few seconds at most for the API', async () => {
  let signal: AbortSignal | undefined
  const { api } = app((_url, init) => {
    signal = init.signal
    return new Promise(() => {})
  })
  const done = api.disable()
  assert.ok(signal, 'the DELETE has a timeout')
  assert.equal(api.device(), undefined)
  void done
})
