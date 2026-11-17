// Codex calls Brigade's tools from scripts it runs, and ends its turn whatever a call waits on: a
// ticket that paused the turn until a person answered left the thread stuck once Codex had ended
// it (Nov 17: 76 minutes, until the member wrote again). On Codex a ticket or question opens and
// returns at once (codex-asks.ts), and the answer comes as a message. Through the real patched
// Codex bridge, with its stand-in for `codex app-server` calling open_ticket mid-turn, as Codex
// does, and the runner's own thread (HarnessThread) on top.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createCodex } from '@ai-sdk/harness-codex'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'
import type { ToolSet } from 'ai'
import { asksWithoutWaiting } from '../src/harness/codex-asks.js'
import type { WaitingCall } from '../src/harness/closed-turn.js'
import { agentKey, HarnessThread } from '../src/harness/index.js'
import { createLocalSandboxSession, freePort } from '../src/harness/local-sandbox.js'
import { toolSpecs } from '../src/harness/tool-changes.js'
import { askUserTool, openTicketTool } from '../src/harness/tools.js'
import { toNative } from '../src/windows.js'
import { fakeInstall } from './fixtures/codex-bridge.js'

const TICKET = {
  title: 'Sign in to X',
  asks: [{ id: 'x_login', type: 'action', title: 'Sign in as @georges_petrov', browser: true }],
}

/** A Codex thread on a computer of its own, whose stand-in makes `call` in its first turn. */
async function codexThread(call: { tool: string; arguments: unknown }, waits = false) {
  const home = await mkdtemp(join(tmpdir(), 'codex-asks-'))
  const work = join(home, 'work')
  await mkdir(work, { recursive: true })
  const record = join(home, 'record.jsonl')
  const spec = {
    sessionId: 'codex-asks',
    starter: true,
    teammate: { id: 'cody', name: 'Cody', harness: 'codex', kind: 'teammate' },
    account: { id: 'acct' },
    connectors: [],
    fallbacks: [],
  } as unknown as ThreadSpec
  const events: AgentEvent[] = []
  const sandboxes: ReturnType<typeof createLocalSandboxSession>[] = []
  const thread = new HarnessThread(
    spec,
    work,
    home,
    (event) => events.push(event),
    async () => ({ output: null, attachments: [] }),
    async () => null,
    {} as never,
  )
  const opened = (c: WaitingCall) => (thread as unknown as { openAsk: typeof open }).openAsk(c)
  const open = async (c: WaitingCall) => opened(c)
  // `waits`: the tools as on Claude Code, which pause the turn until a person answers.
  const tools: ToolSet = waits
    ? { open_ticket: openTicketTool, ask_user: askUserTool }
    : asksWithoutWaiting(open)
  Object.assign(thread, {
    attach: async function (this: {
      live?: unknown
      saved?: { resume?: unknown; accountId?: string }
      begin: (live: unknown, specs: unknown, resume: unknown) => unknown
    }) {
      if (this.live) return this.live
      const sandbox = createLocalSandboxSession({
        id: `${spec.sessionId}-${sandboxes.length}`,
        workingDirectory: work,
        port: await freePort(),
        env: {
          ...(process.platform === 'win32' ? (process.env as Record<string, string>) : {}),
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: join(home, '.codex'),
          FAKE_CODEX_RECORD: record,
          FAKE_CODEX_CALL: JSON.stringify(call),
          FAKE_CODEX_REPLY: 'I opened a ticket: sign in to X, then I post the reply.',
        },
      })
      sandboxes.push(sandbox)
      const run = sandbox.run
      const bootstrapRun: typeof run = async (input) => {
        if (input.command.startsWith('pnpm install')) {
          await fakeInstall(toNative(input.workingDirectory ?? '.', work))
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return run(input)
      }
      const restricted = { ...sandbox.restricted(), run: bootstrapRun }
      const sandboxSession = { ...sandbox, run: bootstrapRun, restricted: () => restricted }
      const agent = new HarnessAgent({
        harness: createCodex({ auth: {} }),
        tools,
        toolApproval: Object.fromEntries(
          Object.keys(tools).map((name) => [name, 'not-applicable' as const]),
        ),
        permissionMode: 'allow-all',
        sandboxConfig: { workDir: '.' },
      })
      const session = await agent.createSession({ sandboxSession: sandboxSession as never })
      return this.begin(
        {
          agent,
          session,
          sandbox,
          account: spec.account,
          credentials: { cleanup: async () => {} },
          made: agentKey(spec),
        },
        toolSpecs(tools),
        undefined,
      )
    },
  })
  const recorded = async () =>
    (await readFile(record, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: any })
  const run = (input: Parameters<HarnessThread['run']>[0]) =>
    thread.run(input, spec, new AbortController().signal)
  const done = async () => {
    await thread.park().catch(() => undefined)
    for (const sandbox of sandboxes) await Promise.resolve(sandbox.destroy()).catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  }
  return { thread, run, events, recorded, done, home }
}

/** The text of each turn Codex was given, in order. */
const inputs = (requests: { method: string; params: any }[]) =>
  requests
    .filter((r) => r.method === 'turn/start')
    .map((r) => (r.params.input as { text?: string }[]).map((i) => i.text ?? '').join(''))

test(
  'Codex: a ticket opens without holding its turn, which ends; the answer comes as a message',
  { timeout: 60_000 },
  async () => {
    const t = await codexThread({ tool: 'open_ticket', arguments: TICKET })
    try {
      // The turn that opens the ticket ends, with what the teammate wrote after it.
      assert.deepEqual(await t.run({ kind: 'prompt', text: 'Reply to Jaimy on X' }), {
        status: 'idle',
      })
      const answered = (await t.recorded()).find((r) => r.method === 'tool/answered')
      assert.ok(answered, 'Codex got its tool call answered at once')
      assert.equal(answered.params.success, true)
      assert.match(answered.params.contentItems[0].text, /"opened":true/)
      assert.match(answered.params.contentItems[0].text, /Your ticket \\"Sign in to X\\" is open/)
      const opened = t.events.find((e) => e.type === 'ticket.opened')
      assert.equal(opened?.type === 'ticket.opened' && opened.requestId, 'call-1')
      assert.ok(
        t.events.some(
          (e) => e.type === 'message.done' && /I opened a ticket: sign in to X/.test(e.text),
        ),
        'what it wrote after the ticket reaches the thread',
      )
      // Over, the thread still waits on the person: it says so. No turn does: a new message, or a
      // hand back after they used the browser, is not held for it (as for an ask set aside).
      const ended = t.events.filter((e) => e.type === 'turn.completed')
      assert.equal(ended.length, 1)
      assert.equal(ended[0]!.type === 'turn.completed' && ended[0]!.waiting, true)
      assert.equal(await t.thread.holdsMessages(), false)
      assert.equal(await t.thread.awaitingPerson(), false)

      // The person answers: a message of its own, in the same Codex thread.
      const outcome = await t.run({
        kind: 'ticket',
        requestId: 'call-1',
        answer: { action: 'answered', replies: { x_login: { type: 'action', done: true } } },
      } as never)
      assert.deepEqual(outcome, { status: 'idle' })
      const turns = inputs(await t.recorded())
      assert.equal(turns.length, 2, JSON.stringify(turns))
      assert.match(turns[1]!, /The person answered your ticket "Sign in to X"/)
      assert.match(turns[1]!, /"ask":"Sign in as @georges_petrov","done":true/)
      assert.match(turns[1]!, /The person used your browser/)
      const last = t.events.filter((e) => e.type === 'turn.completed').at(-1)
      assert.equal(last?.type === 'turn.completed' && last.waiting, undefined)
    } finally {
      await t.done()
    }
  },
)

test(
  'Codex: a question opens without holding its turn, and its answer comes as a message',
  { timeout: 60_000 },
  async () => {
    const t = await codexThread({
      tool: 'ask_user',
      arguments: { questions: [{ id: 'tone', question: 'Formal or casual?' }] },
    })
    try {
      assert.deepEqual(await t.run({ kind: 'prompt', text: 'Draft the reply' }), { status: 'idle' })
      const answered = (await t.recorded()).find((r) => r.method === 'tool/answered')
      assert.match(answered?.params.contentItems[0].text ?? '', /"asked":true/)
      assert.ok(t.events.some((e) => e.type === 'question.asked'))
      const asked = t.events.filter((e) => e.type === 'turn.completed').at(-1)
      assert.equal(asked?.type === 'turn.completed' && asked.waiting, true)
      assert.deepEqual(
        await t.run({
          kind: 'answer',
          questionId: 'call-1',
          answer: { action: 'answered', answers: { tone: { optionIds: [], freeform: 'Casual' } } },
        } as never),
        { status: 'idle' },
      )
      const turns = inputs(await t.recorded())
      assert.match(turns[1]!, /The person answered your question/)
      assert.match(turns[1]!, /Casual/)
    } finally {
      await t.done()
    }
  },
)

test(
  'Codex: an invalid ticket is refused at once, and nothing stays open',
  { timeout: 60_000 },
  async () => {
    const t = await codexThread({ tool: 'open_ticket', arguments: { title: 'No asks' } })
    try {
      assert.deepEqual(await t.run({ kind: 'prompt', text: 'Ask me' }), { status: 'idle' })
      const answered = (await t.recorded()).find((r) => r.method === 'tool/answered')
      assert.equal(answered?.params.success, false)
      assert.match(answered?.params.contentItems[0].text ?? '', /Invalid ticket/)
      const ended = t.events.filter((e) => e.type === 'turn.completed').at(-1)
      assert.equal(ended?.type === 'turn.completed' && ended.waiting, undefined)
    } finally {
      await t.done()
    }
  },
)

test(
  'Codex: a ticket shows, and Codex hears it opened, only once the runner kept it',
  { timeout: 60_000 },
  async () => {
    const t = await codexThread({ tool: 'open_ticket', arguments: TICKET })
    // The thread's state write that keeps the ask, held until released: a runner stopped there
    // must not leave a ticket the person sees, and may answer, that its state does not know.
    const inner = t.thread as unknown as {
      persist: () => Promise<void>
      saved?: { later?: unknown[] }
    }
    const persist = inner.persist.bind(t.thread)
    let reached!: () => void
    const held = new Promise<void>((resolve) => (reached = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let once = false
    inner.persist = async () => {
      if (!once && inner.saved?.later?.length) {
        once = true
        reached()
        await gate
      }
      return persist()
    }
    const running = t.run({ kind: 'prompt', text: 'Reply to Jaimy on X' })
    try {
      await held
      await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal(
        t.events.some((e) => e.type === 'ticket.opened'),
        false,
        'not shown before it is kept',
      )
      assert.equal(
        (await t.recorded()).some((r) => r.method === 'tool/answered'),
        false,
        'Codex does not hear it opened before it is kept',
      )
      release()
      assert.deepEqual(await running, { status: 'idle' })
      assert.ok(t.events.some((e) => e.type === 'ticket.opened'))
      const state = JSON.parse(await readFile(join(t.home, 'codex-asks.json'), 'utf8')) as {
        later?: { toolCallId: string; input: unknown }[]
      }
      assert.deepEqual(
        state.later?.map((c) => c.toolCallId),
        ['call-1'],
      )
      assert.deepEqual(state.later?.[0]?.input, TICKET)
    } finally {
      release()
      await running.catch(() => undefined)
      await t.done()
    }
  },
)
