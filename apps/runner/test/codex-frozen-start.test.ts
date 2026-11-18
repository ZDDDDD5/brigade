// A Codex turn frozen by a restart or an update before its conversation started (thread/start
// still under way): the saved state has no threadId. Continued in place without its bridge (one
// that stopped, or one an older runner started, which this one cannot attach to), Codex would start
// a new conversation told only "Continue.", the person's request lost. The turn is told the thread
// instead, with the request; a turn frozen in a conversation still goes on in it.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ThreadSpec } from '@brigade/contracts'

const { HarnessThread } = await import('../src/harness/index.js')

const REQUEST = 'Rename the export button to Download CSV'

async function recovered(data: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-codex-frozen-'))
  test.after(() => rm(dir, { recursive: true, force: true }))
  const spec = {
    sessionId: 'codex-frozen',
    starter: true,
    teammate: { id: 'cody', name: 'Cody', harness: 'codex', kind: 'teammate' },
    account: { id: 'acct' },
    connectors: [],
    fallbacks: [],
  } as unknown as ThreadSpec
  const thread = new HarnessThread(
    spec,
    dir,
    dir,
    () => {},
    async () => ({ output: null, attachments: [] }),
    async () => null,
    { callSchedule: async () => ({}) } as never,
  )
  const internals = thread as unknown as {
    saved?: Record<string, unknown>
    recover: (
      unseen: string,
      spec: ThreadSpec,
    ) => Promise<{ input: { kind: string; text: string }; handoff?: string } | null>
  }
  // What the runner before this one wrote as it handed the turn over, its bridge a token one.
  internals.saved = {
    accountId: 'acct',
    transcript: [{ role: 'user', text: REQUEST }],
    asked: REQUEST,
    inTurn: false,
    resume: {
      type: 'resume-session',
      harnessId: 'codex',
      specificationVersion: 'harness-v1',
      data: {},
      continueFrom: {
        type: 'continue-turn',
        harnessId: 'codex',
        specificationVersion: 'harness-v1',
        data: { bridge: { port: 1, token: 't', lastSeenEventId: 3 }, ...data },
        pendingToolResults: [],
      },
    },
    handedOver: { groups: [], calls: [] },
  }
  return { result: await internals.recover('', spec), saved: internals.saved }
}

test('a Codex turn frozen before its conversation started is told the thread, request included', async () => {
  const { result, saved } = await recovered({})
  assert.ok(result?.handoff?.includes(REQUEST), result?.handoff)
  assert.equal(saved?.resume, undefined)
})

test('a Codex turn frozen in its conversation goes on in it', async () => {
  const { result, saved } = await recovered({ threadId: 'thr_1' })
  assert.deepEqual(result, { input: { kind: 'resume', text: '' } })
  assert.ok(saved?.resume)
})
