import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import type { AccountRef, AgentEvent, ConnectorGrant } from '@brigade/contracts'
import { EventMapper } from '../src/harness/events.js'
import { createLocalSandboxSession, freePort } from '../src/harness/local-sandbox.js'
import { createPiHarness, loginCredentials, piModel } from '../src/harness/pi.js'
import { loadPi } from '../src/pi-package.js'
import {
  connectorTools,
  doneTools,
  openTicketTool,
  OPEN_TICKET_TOOL,
  type ConnectorCaller,
  type ScheduleCaller,
} from '../src/harness/tools.js'

// The devDependency's Pi; with PI_TEST_INSTALL_ROOT, the runner's own install of it there, as a
// runner from its bundle makes on first use (pi-package.ts).
const pi = await loadPi(
  process.env.PI_TEST_INSTALL_ROOT
    ? { fromPackage: false, root: process.env.PI_TEST_INSTALL_ROOT }
    : {},
)

// A teammate on Pi, as a turn runs it (createAgent): HarnessAgent over Pi, with Brigade's own
// tools as the agent's tools, the teammate's browser as an MCP server, and the Claude login on the
// computer. Pi calls Anthropic's API itself: here a local stand-in, which answers as the API does
// and keeps what Pi sent it (its headers, its tools, the results it was given).

type Sent = { headers: IncomingMessage['headers']; body: any }

/** What the stand-in answers next: a tool call by the name Pi gave the tool, or text. */
type Step = { tool: string; input: object } | { text: string }

let server: Server
let baseUrl: string
const sent: Sent[] = []
const steps: Step[] = []

const read = async (request: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** One answer as Anthropic's Messages API streams it. */
function answer(step: Step, tools: { name: string }[]) {
  const usage = { input_tokens: 12, output_tokens: 3 }
  const events: [string, object][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${sent.length}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          usage,
        },
      },
    ],
  ]
  if ('tool' in step) {
    // Pi names tools as Claude Code does on a subscription token (Read, Bash…): the one it sent.
    const name = tools.find((t) => t.name.toLowerCase() === step.tool.toLowerCase())?.name
    assert.ok(name, `Pi offered no tool ${step.tool}: ${tools.map((t) => t.name).join(', ')}`)
    events.push(
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: `toolu_${sent.length}`, name, input: {} },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) },
        },
      ],
    )
  } else
    events.push(
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } },
      ],
    )
  events.push(
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool' in step ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 7 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  )
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')
}

before(async () => {
  server = createServer(async (request, response) => {
    const body = JSON.parse(await read(request))
    sent.push({ headers: request.headers, body })
    let text: string
    try {
      text = answer(steps.shift() ?? { text: 'Done.' }, body.tools ?? [])
    } catch (error) {
      // Said as the API would, so the turn ends with it rather than wait on an answer.
      response.writeHead(400, { 'content-type': 'application/json' })
      return response.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: String(error) },
        }),
      )
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(text)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(() => new Promise<void>((done) => server.close(() => done())))

/** A Claude login as Claude Code keeps it on a member's machine: .credentials.json. */
async function claudeLogin(dir: string, accessToken: string, refreshToken: string) {
  await writeFile(
    join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + 8 * 3600_000 },
    }),
  )
}

const account: AccountRef = { id: 'acc-claude', provider: 'claude_code', source: 'machine' }

const grant = {
  connectionId: 'c1',
  kind: 'posthog',
  label: 'PostHog',
  externalAccount: 'Brigade',
  scope: 'read',
  operations: [
    {
      name: 'posthog_query',
      description: 'Query PostHog.',
      write: false,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ],
} as unknown as ConnectorGrant

/** A turn on Pi in a fresh folder, with Brigade's tools; its events as the runner maps them. */
async function piTurn(options: {
  prompt: string
  configDir: string
  calls: Parameters<ConnectorCaller>[0][]
  scheduled: Parameters<ScheduleCaller>[0][]
  permissionMode?: 'allow-reads' | 'allow-all'
  mcpServers?: Record<string, unknown>
}) {
  const workDir = await mkdtemp(join(tmpdir(), 'pi-turn-'))
  const tools = {
    ...connectorTools([grant], async (call) => {
      options.calls.push(call)
      return { rows: [['signups', 42]] }
    }),
    ...doneTools(
      async (call) => {
        options.scheduled.push(call)
        return { done: true }
      },
      { child: false, playbook: false },
    ),
    [OPEN_TICKET_TOOL]: openTicketTool,
  }
  const agent = new HarnessAgent({
    harness: createPiHarness({
      pi,
      account,
      effort: undefined,
      mcpServers: options.mcpServers ?? {},
      skills: [],
      credentials: loginCredentials(account, { env: { CLAUDE_CONFIG_DIR: options.configDir } }),
      providers: { anthropic: { baseUrl } } as never,
    }),
    tools,
    // As createAgent: the API checks Brigade's tools, the harness does not ask again.
    toolApproval: Object.fromEntries(
      Object.keys(tools).map((name) => [name, 'not-applicable' as const]),
    ),
    model: piModel(account, 'claude-opus-5-5'),
    instructions: 'You are Riley, a teammate in Brigade.',
    permissionMode: options.permissionMode ?? 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: `pi-${Date.now()}`,
    workingDirectory: workDir,
    port: await freePort(),
    env: { PATH: process.env.PATH ?? '' },
  })
  const events: AgentEvent[] = []
  const session = await agent.createSession({
    sessionId: `pi-${Date.now()}`,
    sandboxSession: sandbox,
  })
  try {
    const mapper = new EventMapper((event) => events.push({ ...event, at: '' } as AgentEvent))
    const result = await agent.stream({ session, prompt: options.prompt })
    for await (const part of result.fullStream) {
      if (process.env.PI_DEBUG) console.error(JSON.stringify(part).slice(0, 300))
      mapper.map(part)
    }
    return { events, mapper, workDir }
  } finally {
    await session.destroy().catch(() => undefined)
    await sandbox.destroy()
    await rm(workDir, { recursive: true, force: true })
  }
}

const finished = (events: AgentEvent[]) =>
  events.filter(
    (e): e is Extract<AgentEvent, { type: 'tool.finished' }> => e.type === 'tool.finished',
  )

test('a teammate on Pi calls an App and completes the thread with Brigade’s own tools', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'pi-claude-'))
  await claudeLogin(
    configDir,
    'sk-ant-oat01-first-access-token-aaaaaaaaaaaa',
    'sk-ant-ort01-refresh',
  )
  sent.length = 0
  steps.push(
    { tool: 'posthog_query', input: { query: 'signups this week' } },
    { tool: 'complete_thread', input: { summary: 'Weekly signups reported' } },
    { text: '42 signups this week.' },
  )
  const calls: Parameters<ConnectorCaller>[0][] = []
  const scheduled: Parameters<ScheduleCaller>[0][] = []
  const { events, mapper } = await piTurn({
    prompt: 'How many signups this week?',
    configDir,
    calls,
    scheduled,
  })
  assert.equal(mapper.error, undefined)
  // The App call went to the API (callConnector), with the model's input.
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.operation, 'posthog_query')
  assert.deepEqual(calls[0]!.input, { query: 'signups this week' })
  // complete_thread went to Brigade (callSchedule).
  assert.equal(scheduled[0]?.operation.name, 'complete_thread')
  // Their results reached the model, and the runner saw both calls end well.
  assert.match(JSON.stringify(sent[1]!.body.messages), /signups/)
  assert.deepEqual(
    finished(events).map((e) => [e.toolName, e.isError]),
    [
      ['posthog_query', false],
      ['complete_thread', false],
    ],
  )
  assert.ok(events.some((e) => e.type === 'message.done' && /42 signups/.test(e.text)))
  // Brigade's instructions are in the system prompt.
  assert.match(JSON.stringify(sent[0]!.body.system), /You are Riley/)
  // On the Claude login's own token, sent as Claude Code sends it.
  for (const request of sent) {
    assert.equal(
      request.headers.authorization,
      'Bearer sk-ant-oat01-first-access-token-aaaaaaaaaaaa',
    )
    assert.match(String(request.headers['user-agent']), /^claude-cli\//)
    assert.match(String(request.headers['anthropic-beta']), /oauth-2025-04-20/)
  }
  assert.equal(sent[0]!.body.model, 'claude-opus-5-5')
  await rm(configDir, { recursive: true, force: true })
})

test('a ticket on Pi waits for its person: the turn stops on the call, with no result', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'pi-claude-'))
  await claudeLogin(configDir, 'sk-ant-oat01-ticket-access-token-bbbbbbbbbbbb', 'sk-ant-ort01-r')
  sent.length = 0
  steps.push({
    tool: OPEN_TICKET_TOOL,
    input: { title: 'Send the report', asks: [{ id: 'a', type: 'approval', title: 'Send it' }] },
  })
  const { events } = await piTurn({
    prompt: 'Draft the report and ask me before sending',
    configDir,
    calls: [],
    scheduled: [],
  })
  const call = events.find((e) => e.type === 'tool.started' && e.toolName === OPEN_TICKET_TOOL)
  assert.ok(call, 'the ticket was called')
  // The runner answers it once the person does: the harness gave it no result of its own.
  assert.equal(finished(events).length, 0)
  assert.equal(sent.length, 1)
  await rm(configDir, { recursive: true, force: true })
})

test('Pi asks before a command, as Claude Code does, when the thread allows only reads', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'pi-claude-'))
  await claudeLogin(configDir, 'sk-ant-oat01-approval-access-token-cccccccccc', 'sk-ant-ort01-r')
  sent.length = 0
  steps.push({ tool: 'bash', input: { command: 'echo hi > note.txt' } })
  const { events } = await piTurn({
    prompt: 'Write a note',
    configDir,
    calls: [],
    scheduled: [],
    permissionMode: 'allow-reads',
  })
  const asked = events.find((e) => e.type === 'approval.requested')
  assert.ok(asked, 'an approval was requested')
  assert.equal(finished(events).length, 0)
  await rm(configDir, { recursive: true, force: true })
})

test('the browser’s tools reach Pi under Claude Code’s names, and its screenshots reach the model', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'pi-claude-'))
  await claudeLogin(configDir, 'sk-ant-oat01-browser-access-token-dddddddddd', 'sk-ant-ort01-r')
  sent.length = 0
  steps.push({ tool: 'mcp__browser__browser_take_screenshot', input: {} }, { text: 'I see it.' })
  const fixture = fileURLToPath(new URL('./fixtures/screenshot-mcp.ts', import.meta.url))
  const { events, mapper } = await piTurn({
    prompt: 'Look at the page',
    configDir,
    calls: [],
    scheduled: [],
    mcpServers: {
      browser: {
        type: 'stdio',
        command: process.execPath,
        // By its path: the server starts in the turn's folder, where tsx is not found by name.
        args: ['--import', import.meta.resolve('tsx'), fixture],
      },
    },
  })
  assert.equal(mapper.error, undefined)
  const done = finished(events).find((e) => e.toolName === 'mcp__browser__browser_take_screenshot')
  assert.ok(done && !done.isError, 'the screenshot tool ran')
  // The picture went back to the model as an image, not as text.
  const results = JSON.stringify(sent[1]!.body.messages)
  assert.match(results, /"type":"image"/)
  assert.match(results, /image\/png/)
  await rm(configDir, { recursive: true, force: true })
})

test('Pi takes the token Claude Code refreshed, and never refreshes or writes it itself', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'pi-claude-'))
  await claudeLogin(configDir, 'sk-ant-oat01-before-refresh-eeeeeeeeeeeeeeee', 'sk-ant-ort01-one')
  sent.length = 0
  steps.push({ text: 'First.' })
  await piTurn({ prompt: 'One', configDir, calls: [], scheduled: [] })
  // Claude Code refreshes the login between the two turns: a new access token, and a new
  // refresh token that alone works from now on.
  await claudeLogin(configDir, 'sk-ant-oat01-after-refresh-ffffffffffffffff', 'sk-ant-ort01-two')
  const { readFile } = await import('node:fs/promises')
  const written = await readFile(join(configDir, '.credentials.json'), 'utf8')
  steps.push({ text: 'Second.' })
  await piTurn({ prompt: 'Two', configDir, calls: [], scheduled: [] })
  assert.equal(
    sent[0]!.headers.authorization,
    'Bearer sk-ant-oat01-before-refresh-eeeeeeeeeeeeeeee',
  )
  assert.equal(sent[1]!.headers.authorization, 'Bearer sk-ant-oat01-after-refresh-ffffffffffffffff')
  // The file is as Claude Code left it: its refresh token is still the one that works.
  assert.equal(await readFile(join(configDir, '.credentials.json'), 'utf8'), written)
  await rm(configDir, { recursive: true, force: true })
})
