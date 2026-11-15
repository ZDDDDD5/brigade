import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComputerUseError, Line, type RequestOptions } from '../src/computer-use.js'
import type { AppInput } from '../src/harness/desktop-tools.js'
import { computerUseTools, type ComputerUse } from '../src/harness/tools.js'

type Call = { method: string; params: Record<string, unknown>; options?: RequestOptions }

function computer(answer: (call: Call) => Promise<unknown>) {
  const calls: Call[] = []
  const use: ComputerUse = {
    request: (method, params, _signal, options) => {
      const call = { method, params, ...(options && { options }) }
      calls.push(call)
      return answer(call)
    },
    workDir: '/work/thread',
    env: () => ({ PATH: '/opt/homebrew/bin:/usr/bin' }),
    screenshotPath: () => ({ path: 'images/x.png', absolute: '/work/thread/images/x.png' }),
    share: () => undefined,
  }
  return { use, calls }
}

const options = (abortSignal?: AbortSignal) =>
  ({ toolCallId: 'call-1', messages: [], abortSignal }) as never

test('computer_run asks the helper to run it, in the working directory, once, as long as it may last', async () => {
  const { use, calls } = computer(async () => ({ exitCode: 0, output: 'granted\n' }))
  const result = await computerUseTools(use).computer_run!.execute!(
    { command: 'agent-desktop permissions', cwd: 'sub', timeout: 5000 },
    options(),
  )
  assert.deepEqual(result, { exitCode: 0, output: 'granted\n' })
  assert.deepEqual(calls, [
    {
      method: 'run',
      params: {
        command: 'agent-desktop permissions',
        cwd: '/work/thread/sub',
        env: { PATH: '/opt/homebrew/bin:/usr/bin' },
        timeout: 1800,
      },
      options: { wait: 1830_000, once: true },
    },
  ])
})

test('computer_run: the default timeout, and an absolute cwd as it is', async () => {
  const { use, calls } = computer(async () => ({ exitCode: 0, output: '' }))
  await computerUseTools(use).computer_run!.execute!({ command: 'true', cwd: '/tmp' }, options())
  assert.equal(calls[0]!.params.cwd, '/tmp')
  assert.equal(calls[0]!.params.timeout, 120)
})

test('an interrupted turn cancels its command in the helper', async () => {
  const controller = new AbortController()
  const { use, calls } = computer(async (call) =>
    call.method === 'run'
      ? new Promise((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        )
      : { ok: true },
  )
  const running = computerUseTools(use).computer_run!.execute!(
    { command: 'sleep 100' },
    options(controller.signal),
  )
  controller.abort()
  await assert.rejects(running as Promise<unknown>, /aborted/)
  assert.deepEqual(
    calls.map((c) => c.method),
    ['run', 'cancel'],
  )
})

test('an older helper without run: the teammate is told to update Brigade.app', async () => {
  const { use } = computer(async () => {
    throw new ComputerUseError('unknown_method', 'unknown method run')
  })
  await assert.rejects(
    computerUseTools(use).computer_run!.execute!(
      { command: 'true' },
      options(),
    ) as Promise<unknown>,
    /update Brigade\.app/,
  )
})

test('commands wait their turn in the line rather than being refused, in the order asked', async () => {
  const line = new Line()
  const order: string[] = []
  let releaseFirst!: () => void
  const first = line.run(async () => {
    order.push('first starts')
    await new Promise<void>((resolve) => (releaseFirst = resolve))
    order.push('first ends')
    return 1
  })
  const second = line.run(async () => {
    order.push('second')
    return 2
  })
  const third = line.run(async () => {
    order.push('third')
    return 3
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(order, ['first starts'])
  releaseFirst()
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 3])
  assert.deepEqual(order, ['first starts', 'first ends', 'second', 'third'])
})

test('a command whose turn was interrupted, or that waited too long, leaves the line without running', async () => {
  const line = new Line(50)
  let releaseFirst!: () => void
  const first = line.run(() => new Promise<void>((resolve) => (releaseFirst = resolve)))
  const controller = new AbortController()
  let ran = 0
  const interrupted = line.run(async () => void ran++, controller.signal)
  controller.abort()
  await assert.rejects(interrupted, /aborted/)
  await assert.rejects(
    line.run(async () => void ran++),
    (error: unknown) => error instanceof ComputerUseError && error.code === 'busy',
  )
  // The one after still waits for the one running, then runs.
  const later = line.run(async () => void ran++)
  releaseFirst()
  await first
  await later
  assert.equal(ran, 1)
})

test('a key for a named app goes to what has its focus while it is in front, one named key at a time', async () => {
  // Cody's interleaving (review of #856): two named-app keys in parallel, each bringing its app forward.
  let front = 'Finder'
  const deliveries: { key: string; app: string }[] = []
  const { use, calls } = computer(async (call) => {
    if (call.method === 'open_app') {
      await new Promise((resolve) => setTimeout(resolve, 5))
      front = call.params.app as string
      return { name: front, active: true }
    }
    if (call.method === 'apps') return { apps: [{ name: front, active: true }] }
    if (call.method === 'key') deliveries.push({ key: call.params.key as string, app: front })
    return { ok: true }
  })
  const tools = computerUseTools(use)
  const answers = await Promise.all([
    tools.computer_key!.execute!({ app: 'TextEdit', key: 'cmd+a', front: true }, options()),
    tools.computer_key!.execute!({ app: 'Calculator', key: 'escape', front: true }, options()),
  ])
  assert.deepEqual(answers, [
    { to: 'TextEdit', broughtToFront: true },
    { to: 'Calculator', broughtToFront: true },
  ])
  assert.deepEqual(deliveries, [
    { key: 'cmd+a', app: 'TextEdit' },
    { key: 'escape', app: 'Calculator' },
  ])
  // The keyboard's key, not a key for the app's process: a save sheet's Cmd+Shift+G reaches the
  // panel, which runs in a process of its own.
  assert.deepEqual(
    calls.filter((c) => c.method === 'key').map((c) => c.params),
    [{ key: 'cmd+a' }, { key: 'escape' }],
  )
})

test('a key for an app behind another is refused, unless front: true brings it forward first', async () => {
  let front = 'Google Chrome'
  const { use, calls } = computer(async (call) => {
    if (call.method === 'apps')
      return {
        apps: [
          { name: front, active: true },
          { name: 'TextEdit', active: false },
        ],
      }
    if (call.method === 'open_app') {
      front = 'TextEdit'
      return { name: 'TextEdit', active: true }
    }
    return { ok: true }
  })
  const tools = computerUseTools(use)
  await assert.rejects(
    tools.computer_key!.execute!({ key: 'cmd+s', app: 'TextEdit' }, options()) as Promise<unknown>,
    /TextEdit is behind Google Chrome.*nothing was sent.*front: true/s,
  )
  assert.deepEqual(
    calls.map((c) => c.method),
    ['apps'],
  )
  assert.deepEqual(
    await tools.computer_key!.execute!({ key: 'cmd+s', app: 'TextEdit', front: true }, options()),
    { to: 'TextEdit', broughtToFront: true },
  )
  assert.deepEqual(
    calls.slice(1).map((c) => c.method),
    ['apps', 'open_app', 'key', 'apps'],
  )
  // Already in front (by its bundle id here): sent as it is.
  const inFront = computer(async () => ({
    apps: [{ name: 'TextEdit', bundleId: 'com.apple.TextEdit', active: true }],
  }))
  assert.deepEqual(
    await computerUseTools(inFront.use).computer_key!.execute!(
      { key: 'cmd+b', app: 'com.apple.textedit' },
      options(),
    ),
    { to: 'com.apple.textedit' },
  )
})

test('a key whose app lost the front as it was sent says so', async () => {
  let asked = 0
  const { use } = computer(async (call) =>
    call.method === 'apps'
      ? { apps: [{ name: ++asked === 1 ? 'TextEdit' : 'Brigade', active: true }] }
      : { ok: true },
  )
  const answer = (await computerUseTools(use).computer_key!.execute!(
    { key: 'return', app: 'TextEdit' },
    options(),
  )) as Record<string, string>
  assert.match(answer.warning!, /Brigade was in front right after it was sent/)
})

test('opening an app answers once a window of it is there, with its windows', async () => {
  let asked = 0
  const appInput: AppInput = {
    type: async () => ({}),
    windows: async () => (++asked < 3 ? [] : [{ id: 'w-1', title: 'Open' }]),
  }
  const { use } = computer(async () => ({ name: 'TextEdit', active: true }))
  assert.deepEqual(
    await computerUseTools(use, appInput).computer_open_app!.execute!(
      { app: 'TextEdit' },
      options(),
    ),
    { name: 'TextEdit', active: true, windows: [{ id: 'w-1', title: 'Open' }] },
  )
  assert.equal(asked, 3)
})

test('a key without an app goes to the app in front, which the answer names', async () => {
  const { use, calls } = computer(async (call) =>
    call.method === 'apps'
      ? {
          apps: [
            { name: 'Brigade', active: true },
            { name: 'TextEdit', active: false },
          ],
        }
      : { ok: true },
  )
  assert.deepEqual(
    await computerUseTools(use).computer_key!.execute!({ key: 'return' }, options()),
    { ok: true, front: 'Brigade' },
  )
  assert.deepEqual(
    calls.map((c) => [c.method, c.params]),
    [
      ['apps', {}],
      ['key', { key: 'return' }],
    ],
  )
})

test('opening an app: a Stop while waiting for its window ends the call with the Stop', async () => {
  let asked = 0
  const appInput: AppInput = {
    type: async () => ({}),
    windows: async () => {
      asked++
      throw new ComputerUseError(
        'stopped',
        'The person pressed Stop on the computer-use indicator.',
      )
    },
  }
  const { use } = computer(async () => ({ name: 'TextEdit', active: true }))
  await assert.rejects(
    computerUseTools(use, appInput).computer_open_app!.execute!(
      { app: 'TextEdit' },
      options(),
    ) as Promise<unknown>,
    (error: unknown) => error instanceof ComputerUseError && error.code === 'stopped',
  )
  assert.equal(asked, 1)
})

test('text for a named app goes into its focused field from behind, and nothing through the keyboard', async () => {
  const typed: string[] = []
  const appInput: AppInput = {
    type: async (app, text) => {
      typed.push(`${app}:${text}`)
      return { delivery: 'delivered_verified' }
    },
    windows: async () => [],
  }
  const { use, calls } = computer(async () => ({ ok: true }))
  assert.deepEqual(
    await computerUseTools(use, appInput).computer_type!.execute!(
      { app: 'TextEdit', text: 'hi' },
      options(),
    ),
    { to: 'TextEdit', delivery: 'delivered_verified' },
  )
  assert.deepEqual(typed, ['TextEdit:hi'])
  assert.deepEqual(calls, [])
})
