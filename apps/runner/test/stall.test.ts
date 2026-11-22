// A turn whose harness stream goes quiet with nothing running (stall.ts): on 2026-11-22 a
// member's Mac slept mid-response and Claude Code's model request never came back, the thread
// running with no event for over two hours. The runner stops such a stream once it has been
// quiet for BRIGADE_STALL_MS, and the turn fails with an error the thread shows; quiet while a
// tool call runs is expected, and parts that keep coming keep the turn going. The harness is
// scripted, the session the runner's own (HarnessThread), as in stale-wait.test.ts.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'
import { createLocalSandboxSession } from '../src/harness/local-sandbox.js'

// Read as the module loads: a quiet of a fraction of a second, for the test.
const STALL_MS = 300
process.env.BRIGADE_STALL_MS = String(STALL_MS)
const { HarnessThread } = await import('../src/harness/index.js')
const { StallWatch, stalledMessage } = await import('../src/harness/stall.js')

type Emit = (part: Record<string, unknown>) => void

/** A harness whose model starts its response, plays `parts`, then sends nothing until stopped. */
function quietHarness(parts: Record<string, unknown>[], played: { emit?: Emit }) {
  return {
    harnessId: 'scripted',
    specificationVersion: 'harness-v1',
    builtinTools: {},
    supportsBuiltinToolApprovals: true,
    doStart: async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      isResume: false,
      doPromptTurn: async ({ emit, abortSignal }: { emit: Emit; abortSignal?: AbortSignal }) => {
        played.emit = emit
        emit({ type: 'stream-start', modelId: 'scripted' })
        for (const part of parts) emit(part)
        const done = new Promise<void>((resolve) => {
          if (abortSignal?.aborted) return resolve()
          abortSignal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return { submitToolResult: async () => {}, done }
      },
      doContinueTurn: async () => ({ submitToolResult: async () => {}, done: Promise.resolve() }),
      doStop: async () => ({
        type: 'resume-session',
        harnessId: 'scripted',
        specificationVersion: 'harness-v1',
        data: {},
      }),
      doDestroy: async () => {},
    }),
  }
}

async function quietTurn(
  parts: Record<string, unknown>[],
  signal = new AbortController().signal,
  callSchedule: (call: unknown) => Promise<unknown> = async () => ({}),
) {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-stall-'))
  const events: AgentEvent[] = []
  const played: { emit?: Emit } = {}
  const spec = {
    sessionId: 'stall',
    starter: true,
    teammate: { id: 'riley', name: 'Riley', harness: 'claude-code', kind: 'teammate' },
    account: { id: 'acct' },
    connectors: [],
    fallbacks: [],
  } as unknown as ThreadSpec
  const thread = new HarnessThread(
    spec,
    dir,
    dir,
    (event) => events.push(event),
    async () => ({ output: null, attachments: [] }),
    async () => null,
    { callSchedule } as never,
  )
  const agent = new HarnessAgent({
    harness: quietHarness(parts, played) as never,
    tools: {} as never,
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: 'stall',
    workingDirectory: dir,
    port: 0,
    env: {},
  })
  Object.assign(thread, {
    attach: async function (this: { live?: unknown }) {
      if (this.live) return this.live
      const session = await agent.createSession({ sandboxSession: sandbox })
      this.live = {
        agent,
        session,
        sandbox,
        account: spec.account,
        credentials: { cleanup: async () => {} },
        made: JSON.stringify([null, [], undefined]),
        tools: { digests: {}, changed: [] },
      }
      return this.live
    },
  })
  const started = Date.now()
  const outcome = thread.run({ kind: 'prompt', text: 'Write the report' }, spec, signal)
  return {
    outcome,
    events,
    played,
    started,
    errors: () =>
      events.filter((e) => e.type === 'error').map((e) => (e as { message: string }).message),
    async cleanup() {
      await sandbox.destroy().catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  'a response that stops coming with nothing running fails the turn, with an error the thread shows',
  { timeout: 20_000 },
  async () => {
    // The model began to write, then nothing more: a request lost while the computer slept.
    const t = await quietTurn([
      { type: 'text-start', id: 'r' },
      { type: 'text-delta', id: 'r', delta: 'Now the second document.' },
    ])
    try {
      const outcome = await t.outcome
      assert.equal(outcome.status, 'failed')
      assert.equal((outcome as { error?: string }).error, stalledMessage(STALL_MS))
      assert.deepEqual(t.errors(), [stalledMessage(STALL_MS)], 'shown once in the thread')
      assert.ok(Date.now() - t.started >= STALL_MS, 'not before the quiet lasted')
      // What it had written still went out.
      assert.ok(t.events.some((e) => e.type === 'message.delta' || e.type === 'message.done'))
    } finally {
      await t.cleanup()
    }
  },
)

test(
  'a quiet tool call keeps the turn open: a long command is not a stall',
  { timeout: 20_000 },
  async () => {
    const stop = new AbortController()
    const t = await quietTurn(
      [
        {
          type: 'tool-call',
          toolCallId: 'bash-1',
          toolName: 'bash',
          input: '{"command":"pnpm test"}',
          providerExecuted: true,
          dynamic: true,
        },
      ],
      stop.signal,
    )
    try {
      await sleep(STALL_MS * 4)
      assert.deepEqual(t.errors(), [], 'still running its command')
      // Its command ends; the model then sends nothing: quiet counts from then on.
      const ended = Date.now()
      t.played.emit!({
        type: 'tool-result',
        toolCallId: 'bash-1',
        toolName: 'bash',
        result: 'ok',
        providerExecuted: true,
        dynamic: true,
      })
      const outcome = await t.outcome
      assert.equal(outcome.status, 'failed')
      assert.ok(Date.now() - ended >= STALL_MS, 'the quiet counted from the end of the command')
      assert.deepEqual(t.errors(), [stalledMessage(STALL_MS)])
    } finally {
      stop.abort()
      await t.outcome
      await t.cleanup()
    }
  },
)

test(
  "a done block's call, refused, is over: the quiet after it still stalls the turn",
  { timeout: 20_000 },
  async () => {
    // The reply declares the thread done; Brigade refuses (a pull request still open), and the
    // model then sends nothing more. That call finishes through the outbox, not the mapper.
    const t = await quietTurn(
      [
        { type: 'text-start', id: 'r' },
        { type: 'text-delta', id: 'r', delta: 'Merged.\n\n```done\nCSV export merged\n```' },
        { type: 'text-end', id: 'r' },
      ],
      undefined,
      async () => {
        throw new Error('A pull request of this thread is still open')
      },
    )
    try {
      const outcome = await t.outcome
      assert.ok(
        t.events.some((e) => e.type === 'tool.finished' && e.toolName === 'complete_thread'),
        'the refusal went out',
      )
      assert.equal(outcome.status, 'failed')
      assert.deepEqual(t.errors(), [stalledMessage(STALL_MS)])
    } finally {
      await t.cleanup()
    }
  },
)

test('a response that keeps coming is never stopped', { timeout: 20_000 }, async () => {
  const stop = new AbortController()
  const t = await quietTurn([{ type: 'text-start', id: 'r' }], stop.signal)
  try {
    while (!t.played.emit) await sleep(1)
    // Slowly, but always within the quiet allowed: four times as long as it, all told.
    for (let i = 0; i < 12; i++) {
      await sleep(STALL_MS / 3)
      t.played.emit({ type: 'text-delta', id: 'r', delta: `${i} ` })
    }
    assert.deepEqual(t.errors(), [])
  } finally {
    stop.abort()
    await t.outcome
    await t.cleanup()
  }
})

test('time asleep is not quiet: only the monotonic clock counts', () => {
  // performance.now stands still while the computer sleeps; the wall clock moves on.
  let mono = 0
  const stalls: string[] = []
  const watch = new StallWatch({
    busy: () => false,
    onStall: (message) => stalls.push(message),
    now: () => mono,
    quietMs: 1000,
  })
  const done = watch.streaming()
  try {
    mono += 999
    watch.check()
    assert.deepEqual(stalls, [])
    mono += 1
    watch.check()
    assert.equal(stalls.length, 1)
    // Once.
    mono += 5000
    watch.check()
    assert.equal(stalls.length, 1)
  } finally {
    done()
    watch.stop()
  }
})

test('quiet while busy is not counted, and counts again from when it ends', () => {
  let mono = 0
  let busy = true
  const stalls: string[] = []
  const watch = new StallWatch({
    busy: () => busy,
    onStall: (message) => stalls.push(message),
    now: () => mono,
    quietMs: 1000,
  })
  const done = watch.streaming()
  try {
    mono += 10_000
    watch.check()
    assert.deepEqual(stalls, [])
    busy = false
    mono += 999
    watch.check()
    assert.deepEqual(stalls, [], 'counted from the last look while busy')
    mono += 1
    watch.check()
    assert.equal(stalls.length, 1)
  } finally {
    done()
    watch.stop()
  }
})
