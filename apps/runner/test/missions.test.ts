import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation, ThreadSpec } from '@brigade/contracts'
import { instructions } from '../src/instructions.js'
import { threadMemory } from '../src/memory-layers.js'
import { THREAD_TOOLS } from '../src/harness/thread-tools.js'
import { createMissionTools, missionTools, type ScheduleCaller } from '../src/harness/tools.js'

// Missions on the runner (docs/missions.md): a thread of a mission gets its tools and its section of
// the instructions; each tool sends an operation the API reads; its plan is the thread's own.

const options = { toolCallId: 'call-1', messages: [] } as never

const spec = (mission?: unknown, missions = !!mission) =>
  ThreadSpec.parse({
    missions,
    sessionId: 's1',
    teammate: { id: 'maya', name: 'Maya', instructions: '', harness: 'claude_code', model: null },
    permissionMode: 'allow-all',
    account: { id: 'a1', provider: 'claude_code', source: 'machine' },
    fallbacks: [],
    ...(mission ? { mission } : {}),
  })

const mission = {
  id: 'm1',
  title: 'Grow LinkedIn',
  objective: '2,000 followers by January',
  teammate: { id: 'maya', name: 'Maya' },
  number: { label: 'Followers', unit: null },
}

test('a thread of a mission is told what it is for and how to keep its plan', () => {
  const text = (s: ThreadSpec) =>
    instructions(
      s,
      threadMemory(s, { workspace: '', teammate: '', lines: {} }, '/t', new Date()),
      '/library',
      {
        ready: true,
      },
    )
  const withMission = text(spec(mission))
  assert.match(withMission, /## Mission\n\nThis thread works for the mission "Grow LinkedIn"/)
  assert.match(withMission, /`plan_action`/)
  assert.match(withMission, /`record_number`/)
  assert.doesNotMatch(text(spec()), /## Mission/)
})

test('each tool sends an operation the API reads; the number’s only when it follows one', async () => {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = missionTools(async (call) => {
    sent.push(call)
    return {}
  }, mission)
  assert.deepEqual(Object.keys(tools).sort(), [
    'cancel_action',
    'list_actions',
    'plan_action',
    'record_number',
    'record_output',
    'update_mission',
  ])
  assert.ok(!('record_number' in missionTools(async () => ({}), { number: null })))
  await tools.plan_action!.execute!(
    {
      at: '2026-11-17T14:30:00+01:00',
      title: 'Post',
      instructions: 'Publish it',
      draft: 'Hello',
    },
    options,
  )
  await tools.record_output!.execute!(
    { channel: 'linkedin', summary: 'Post', url: 'https://example.com/p', metrics: { likes: 3 } },
    options,
  )
  await tools.record_number!.execute!({ value: 1200 }, options)
  for (const call of sent)
    assert.ok(ScheduleOperation.safeParse(call.operation).success, call.toolName)
  // What the thread plans is its own: its sub-agents put it in their answer instead.
  assert.ok(THREAD_TOOLS.includes('plan_action'))
  assert.ok(THREAD_TOOLS.includes('cancel_action'))
  assert.ok(!THREAD_TOOLS.includes('record_output'))
})

test('where Missions are open, a thread of none is told when to make one, and can', async () => {
  const text = (s: ThreadSpec) =>
    instructions(
      s,
      threadMemory(s, { workspace: '', teammate: '', lines: {} }, '/t', new Date()),
      '/library',
      { ready: true },
    )
  assert.match(text(spec(undefined, true)), /## Missions\n\nWhen the person delegates ongoing work/)
  assert.doesNotMatch(text(spec(undefined, false)), /create_mission/)
  // With a mission, its own section says how to change it instead.
  assert.match(text(spec(mission)), /`update_mission`/)
  assert.doesNotMatch(text(spec(mission)), /## Missions\n/)

  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = createMissionTools(async (call) => {
    sent.push(call)
    return {}
  })
  await tools.create_mission!.execute!(
    {
      title: 'Grow LinkedIn',
      objective: '2,000 followers',
      metric: { label: 'Followers', target: 2000 },
    },
    options,
  )
  await missionTools(async (call) => {
    sent.push(call)
    return {}
  }, mission).update_mission!.execute!({ metric: null, archive: true }, options)
  for (const call of sent)
    assert.ok(ScheduleOperation.safeParse(call.operation).success, call.toolName)
  assert.ok(THREAD_TOOLS.includes('create_mission'))
  assert.ok(THREAD_TOOLS.includes('update_mission'))
})
