// A teammate moved from Pi to Claude Code (or back) between turns, on the same account: its
// conversation is the old harness's, which the new one cannot resume (HarnessAgent refuses a
// lifecycle state of another harness). Its next turn goes on in a new session of the new harness,
// told the thread so far, whether the old session was still live in the runner or saved on disk.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'
import {
  agentKey,
  harnessChanged,
  HarnessThread,
  resumeHarness,
  savedResume,
} from '../src/harness/index.js'
import { createLocalSandboxSession } from '../src/harness/local-sandbox.js'

type Emit = (part: Record<string, unknown>) => void

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0 },
}

const state = (harnessId: string) => ({
  type: 'resume-session',
  harnessId,
  specificationVersion: 'harness-v1',
  data: harnessId === 'pi' ? { entries: [{ type: 'session', id: 's' }] } : {},
})

/** A harness with an adapter id of its own, which answers each prompt and keeps what it heard. */
function scripted(harnessId: string, heard: { harness: string; prompt: string }[]) {
  return {
    harnessId,
    specificationVersion: 'harness-v1',
    builtinTools: {},
    supportsBuiltinToolApprovals: true,
    doStart: async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      isResume: false,
      doPromptTurn: async ({ emit, prompt }: { emit: Emit; prompt: unknown }) => {
        heard.push({ harness: harnessId, prompt: String(prompt) })
        emit({ type: 'stream-start', modelId: 'scripted' })
        emit({ type: 'text-start', id: 'r' })
        emit({ type: 'text-delta', id: 'r', delta: 'Done' })
        emit({ type: 'text-end', id: 'r' })
        emit({ type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' }, usage })
        return { submitToolResult: async () => {}, done: Promise.resolve() }
      },
      doContinueTurn: async () => ({ submitToolResult: async () => {}, done: Promise.resolve() }),
      doStop: async () => state(harnessId),
      doDestroy: async () => {},
    }),
  }
}

const ADAPTER = { pi: 'pi', claude_code: 'claude-code' } as const

async function setup(saved: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-harness-switch-'))
  await writeFile(join(dir, 'switch.json'), JSON.stringify(saved))
  const heard: { harness: string; prompt: string }[] = []
  const events: AgentEvent[] = []
  const spec = (harness: 'pi' | 'claude_code') =>
    ({
      sessionId: 'switch',
      starter: true,
      teammate: { id: 'riley', name: 'Riley', harness, model: null, kind: 'teammate' },
      account: { id: 'acct', provider: 'claude_code', source: 'brigade' },
      connectors: [],
      fallbacks: [],
      effort: null,
    }) as unknown as ThreadSpec
  const thread = new HarnessThread(
    spec('pi'),
    dir,
    dir,
    (event) => events.push(event),
    async () => ({ output: null, attachments: [] }),
    async () => null,
    {} as never,
  )
  const sandboxes: ReturnType<typeof createLocalSandboxSession>[] = []
  /** What each new session resumed, and on which harness. */
  const started: { harness: string; resumed: unknown }[] = []
  Object.assign(thread, {
    // As the real one, with its harness made from the spec and its resume chosen by savedResume.
    attach: async function (this: {
      live?: unknown
      saved?: Parameters<typeof savedResume>[0]
      spec: ThreadSpec
    }) {
      if (this.live) return this.live
      const harness = this.spec.teammate.harness as 'pi' | 'claude_code'
      const agent = new HarnessAgent({
        harness: scripted(ADAPTER[harness], heard) as never,
        tools: {},
        permissionMode: 'allow-all',
        sandboxConfig: { workDir: '.' },
      })
      const resume = savedResume(this.saved, this.spec, this.spec.account)
      started.push({ harness, resumed: resume })
      const sandbox = createLocalSandboxSession({
        id: `switch-${sandboxes.length}`,
        workingDirectory: dir,
        port: 0,
        env: {},
      })
      sandboxes.push(sandbox)
      const session = await agent.createSession({
        sandboxSession: sandbox,
        ...(resume ? { resumeFrom: resume as never } : {}),
      })
      this.live = {
        agent,
        session,
        sandbox,
        account: this.spec.account,
        credentials: { cleanup: async () => {} },
        harness,
        made: agentKey(this.spec),
        tools: { digests: {}, changed: [] },
      }
      return this.live
    },
  })
  const run = (harness: 'pi' | 'claude_code', text: string) =>
    thread.run({ kind: 'prompt', text }, spec(harness), new AbortController().signal)
  /** An answer, an approval or a ticket's answer, as the thread gives it to the teammate. */
  const give = (harness: 'pi' | 'claude_code', input: Parameters<HarnessThread['run']>[0]) =>
    thread.run(input, spec(harness), new AbortController().signal)
  const kept = async () => JSON.parse(await readFile(join(dir, 'switch.json'), 'utf8'))
  const done = async () => {
    for (const sandbox of sandboxes) await Promise.resolve(sandbox.destroy()).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
  return { run, give, heard, started, kept, done }
}

const PI_THREAD = {
  accountId: 'acct',
  resume: state('pi'),
  transcript: [
    { role: 'user', text: 'Benchmark the signup flow' },
    { role: 'assistant', text: 'Done: 3 steps, 2 s each.' },
  ],
}

test('a saved state names its harness, and one of another harness is not resumed', () => {
  assert.equal(resumeHarness(state('claude-code')), 'claude_code')
  assert.equal(resumeHarness(state('pi')), 'pi')
  assert.equal(resumeHarness({ continueFrom: state('codex') }), 'codex')
  assert.equal(resumeHarness(undefined), undefined)
  const spec = (harness: string) => ({ teammate: { harness } }) as unknown as ThreadSpec
  assert.equal(harnessChanged(PI_THREAD, spec('claude_code')), true)
  assert.equal(harnessChanged(PI_THREAD, spec('pi')), false)
  // Nothing saved: nothing to resume, so nothing changed.
  assert.equal(harnessChanged({ accountId: 'acct', transcript: [] }, spec('codex')), false)
  assert.equal(savedResume(PI_THREAD, spec('claude_code'), { id: 'acct' }), undefined)
  assert.deepEqual(savedResume(PI_THREAD, spec('pi'), { id: 'acct' }), state('pi'))
})

test('reopened after the switch: Claude Code starts anew, told the thread so far', async () => {
  const t = await setup(PI_THREAD)
  try {
    const outcome = await t.run('claude_code', 'Now compare with Claude Code')
    assert.deepEqual(outcome, { status: 'idle' })
    assert.deepEqual(t.started, [{ harness: 'claude_code', resumed: undefined }])
    assert.equal(t.heard[0]!.harness, 'claude-code')
    assert.match(t.heard[0]!.prompt, /because you now run on Claude Code/)
    assert.match(t.heard[0]!.prompt, /Benchmark the signup flow/)
    assert.match(t.heard[0]!.prompt, /Now compare with Claude Code/)
    // Pi's conversation is no longer kept: nothing would resume it on Claude Code.
    assert.equal(resumeHarness((await t.kept()).resume), undefined)
  } finally {
    await t.done()
  }
})

test('switched while its Pi session is live: the next turn runs on Claude Code, not Pi', async () => {
  const t = await setup(PI_THREAD)
  try {
    assert.deepEqual(await t.run('pi', 'One more run'), { status: 'idle' })
    assert.equal(t.heard[0]!.harness, 'pi')
    assert.deepEqual(await t.run('claude_code', 'Now on Claude Code'), { status: 'idle' })
    assert.equal(t.heard.length, 2)
    assert.equal(t.heard[1]!.harness, 'claude-code')
    assert.match(t.heard[1]!.prompt, /because you now run on Claude Code/)
    assert.equal(t.started[1]!.harness, 'claude_code')
    assert.equal(t.started[1]!.resumed, undefined)
    // And back to Pi: anew again.
    assert.deepEqual(await t.run('pi', 'Back on Pi'), { status: 'idle' })
    assert.equal(t.heard[2]!.harness, 'pi')
    assert.match(t.heard[2]!.prompt, /because you now run on Pi/)
  } finally {
    await t.done()
  }
})

test('a ticket answered after the switch: Claude Code is told the thread, the ticket and its answer', async () => {
  const ticket = {
    title: 'Approve the reply',
    asks: [{ id: 'send', type: 'approval', title: 'Send the reply', draft: 'To: pat@example.com' }],
  }
  const call = { toolCallId: 'ticket-1', toolName: 'open_ticket', input: ticket }
  const t = await setup({
    ...PI_THREAD,
    // Pi's turn waits on the ticket (continueFrom), as the runner kept it.
    resume: {
      ...state('pi'),
      continueFrom: { ...state('pi'), type: 'continue-turn', pendingToolResults: [call] },
    },
    waiting: [call],
  })
  try {
    const outcome = await t.give('claude_code', {
      kind: 'ticket',
      requestId: 'ticket-1',
      answer: { action: 'answered', replies: { send: { type: 'approval', approved: true } } },
    } as never)
    assert.equal((outcome as { status: string }).status, 'idle')
    assert.deepEqual(t.started, [{ harness: 'claude_code', resumed: undefined }])
    const prompt = t.heard[0]!.prompt
    assert.equal(t.heard[0]!.harness, 'claude-code')
    assert.match(prompt, /because you now run on Claude Code/)
    assert.match(prompt, /Benchmark the signup flow/)
    // The call it answers, with what it asked to approve, and the answer.
    assert.match(prompt, /open_ticket call/)
    assert.match(prompt, /pat@example\.com/)
    assert.match(prompt, /"approved":true/)
  } finally {
    await t.done()
  }
})

test('an approval given after the switch: Claude Code is told the call it approved', async () => {
  const call = { approvalId: 'approval-1', toolName: 'bash', input: { command: 'npm publish' } }
  const t = await setup({
    ...PI_THREAD,
    resume: {
      ...state('pi'),
      continueFrom: {
        ...state('pi'),
        type: 'continue-turn',
        pendingToolApprovals: [{ approvalId: 'approval-1', toolCallId: 'call-1' }],
      },
    },
    approvals: [call],
  })
  try {
    await t.give('claude_code', { kind: 'approval', approvalId: 'approval-1', approved: true })
    const prompt = t.heard[0]!.prompt
    assert.equal(t.heard[0]!.harness, 'claude-code')
    assert.match(prompt, /because you now run on Claude Code/)
    assert.match(prompt, /Benchmark the signup flow/)
    assert.match(prompt, /npm publish/)
    assert.match(prompt, /They approved it/)
  } finally {
    await t.done()
  }
})
