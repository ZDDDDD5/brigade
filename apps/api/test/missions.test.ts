import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Missions (src/initiatives.ts, docs/missions.md) against a real database: a mission's thread plans
// actions, a draft waits for a person before its deadline, the minute's job runs what is due once
// and lets unapproved drafts expire, outputs and numbers are recorded, and the views read it all.
// The local one of apps/api/.env, in an organization of its own that it removes at the end.
// Without a database to reach, it is skipped.
const fromEnvFile = () => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    return line?.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') || undefined
  } catch {
    return undefined
  }
}
process.env.DATABASE_URL ??= fromEnvFile() ?? 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "initiativeId" from "Session" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const {
  decideMissionAction,
  handleInitiativeCall,
  listMissions,
  missionIdOfThread,
  missionWeek,
  runDueActions,
  threadInitiative,
  createMission,
  updateMission,
  moveThreads,
} = await import('../src/initiatives.js')
const { firedInARow } = await import('../src/wakeups.js')
const { resolveTicket } = await import('../src/decide.js')

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-missions-${id}`,
  user: `user-missions-${id}`,
  member: `mem-missions-${id}`,
}
let scope: { organizationId: string; workspaceId: string }
let maya: { id: string; name: string }
let computerId: string
let missionId: string
let mainId: string
/** The feature's row as it was, to put back. */
let flagBefore: { everyone: boolean; workspaceIds: string[] } | null = null

const member = () => ({
  ...scope,
  userId: ids.user,
  memberId: ids.member,
  role: 'owner' as const,
})

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Missions test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Missions test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  // The feature, opened to this workspace alone.
  const flag = await prisma.featureFlag.findUnique({ where: { key: 'missions' } })
  flagBefore = flag ? { everyone: flag.everyone, workspaceIds: flag.workspaceIds } : null
  await prisma.featureFlag.upsert({
    where: { key: 'missions' },
    create: { key: 'missions', workspaceIds: [workspace.id], note: 'missions.test.ts' },
    update: { everyone: false, workspaceIds: { push: workspace.id } },
  })
  const row = await prisma.teammate.create({ data: { ...scope, name: 'Maya' } })
  maya = { id: row.id, name: 'Maya' }
  // Offline: a prompt is kept as a wake-up and waits, as it would.
  const computer = await prisma.computer.create({
    data: { ...scope, kind: 'member_machine', memberId: ids.member, name: 'Laptop' },
  })
  computerId = computer.id
  await prisma.account.create({
    data: {
      ...scope,
      memberId: ids.member,
      computerId,
      provider: 'claude_code',
      label: 'Claude',
      status: 'ready',
    },
  })
  const mission = await prisma.initiative.create({
    data: {
      ...scope,
      teammateId: maya.id,
      title: 'Grow LinkedIn',
      objective: '2,000 followers by January',
      metricLabel: 'Followers',
      metricTarget: 2000,
    },
  })
  missionId = mission.id
  mainId = (await thread({ initiativeId: missionId })).id
})

after(async () => {
  if (skip) return
  if (flagBefore)
    await prisma.featureFlag.update({
      where: { key: 'missions' },
      data: { everyone: flagBefore.everyone, workspaceIds: flagBefore.workspaceIds },
    })
  else await prisma.featureFlag.deleteMany({ where: { key: 'missions' } })
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

let titles = 0
async function thread(data: object) {
  const session = await prisma.session.create({
    data: {
      ...scope,
      teammateId: maya?.id,
      startedByMemberId: ids.member,
      computerId,
      title: `Thread ${++titles}`,
      status: 'idle',
      origin: 'member',
      ...data,
    } as never,
  })
  await prisma.threadTeammate.create({
    data: { ...scope, sessionId: session.id, teammateId: maya.id },
  })
  return session
}

const call = (sessionId: string, op: Parameters<typeof handleInitiativeCall>[4]) =>
  handleInitiativeCall(
    scoped(scope),
    scope,
    { id: sessionId, startedByMemberId: ids.member, workspaceId: scope.workspaceId },
    maya,
    op,
  )

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString()

/** Moves an action's times into the past, as the minute's job would find them later. */
const due = (actionId: string, data: { dueAt?: Date; approveBy?: Date }) =>
  prisma.initiativeAction.update({ where: { id: actionId }, data })

test(
  'a thread of no mission plans nothing; sub-threads and runs belong to their parent’s',
  { skip },
  async () => {
    const loose = await thread({})
    const refused = await call(loose.id, { name: 'list_actions' })
    assert.match((refused as { error: string }).error, /belongs to no mission/)

    const child = await thread({ origin: 'child', parentId: mainId, parentTeammateId: maya.id })
    assert.equal(await missionIdOfThread(scoped(scope), child.id), missionId)
    const schedule = await prisma.schedule.create({
      data: {
        ...scope,
        teammateId: maya.id,
        title: 'Morning',
        instructions: 'Comment',
        cron: '30 9 * * 1-5',
        timezone: 'Europe/Paris',
        ownerMemberId: ids.member,
        initiativeId: missionId,
        nextRunAt: new Date(Date.now() + 3_600_000),
      },
    })
    const run = await thread({ origin: 'schedule', scheduleId: schedule.id })
    assert.equal(await missionIdOfThread(scoped(scope), run.id), missionId)
    // Its spec carries the mission, with its number.
    const spec = await threadInitiative(scoped(scope), {
      id: run.id,
      workspaceId: scope.workspaceId,
      startedByMemberId: ids.member,
    })
    assert.equal(spec?.id, missionId)
    assert.deepEqual(spec?.number, { label: 'Followers', unit: null })
    // An action planned from a standalone run goes to the mission's main thread, which outlives it.
    const planned = (await call(run.id, {
      name: 'plan_action',
      at: inMinutes(60),
      title: 'Post',
      instructions: 'Publish it',
    })) as { actionId: string; threadId: string }
    assert.equal(planned.threadId, mainId)
    await call(mainId, { name: 'cancel_action', actionId: planned.actionId })
  },
)

test('a planned action runs once at its time, in its thread', { skip }, async () => {
  const planned = (await call(mainId, {
    name: 'plan_action',
    at: inMinutes(30),
    title: 'Post: roles',
    instructions: 'Publish the roles post',
  })) as { actionId: string; status: string }
  assert.equal(planned.status, 'planned')
  await runDueActions(scope.workspaceId)
  assert.equal(
    (await prisma.initiativeAction.findUniqueOrThrow({ where: { id: planned.actionId } })).status,
    'planned',
    'not before its time',
  )
  await due(planned.actionId, { dueAt: new Date(Date.now() - 1_000) })
  // Twice, as two ticks racing: one wake-up, one run.
  await Promise.all([runDueActions(scope.workspaceId), runDueActions(scope.workspaceId)])
  const action = await prisma.initiativeAction.findUniqueOrThrow({
    where: { id: planned.actionId },
  })
  assert.equal(action.status, 'fired')
  const wakeups = await prisma.wakeup.findMany({
    where: { sessionId: mainId, sourceId: { startsWith: `action:${planned.actionId}` } },
  })
  assert.equal(wakeups.length, 1)
  assert.equal(wakeups[0]!.sourceId, `action:${planned.actionId}:run`)
  assert.match(wakeups[0]!.note, /^\[Brigade mission action\] "Post: roles"/)
  assert.match(wakeups[0]!.note, /Publish the roles post/)
  // The plan at work is not the teammate checking again: it does not count toward its limit.
  await prisma.wakeup.update({
    where: { id: wakeups[0]!.id },
    data: { status: 'fired', firedAt: new Date() },
  })
  assert.equal(await firedInARow(scoped(scope), mainId), 0)
})

test('a draft waits for a person, then runs with the approved text', { skip }, async () => {
  const planned = (await call(mainId, {
    name: 'plan_action',
    at: inMinutes(120),
    title: 'Post: invites',
    instructions: 'Publish the invites post',
    draft: 'Inviting your team takes one click.',
    approveBy: inMinutes(90),
  })) as { actionId: string; status: string }
  assert.equal(planned.status, 'awaiting_approval')
  const action = await prisma.initiativeAction.findUniqueOrThrow({
    where: { id: planned.actionId },
  })
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: action.ticketId! } })
  assert.equal(ticket.type, 'approval')
  assert.equal(ticket.sessionId, mainId)
  // Not due: it waits for the person, whatever the time.
  await due(planned.actionId, {
    dueAt: new Date(Date.now() - 1_000),
    approveBy: new Date(Date.now() + 60_000),
  })
  await runDueActions(scope.workspaceId)
  assert.equal(
    (await prisma.initiativeAction.findUniqueOrThrow({ where: { id: planned.actionId } })).status,
    'awaiting_approval',
  )
  await decideMissionAction(scoped(scope), member(), ticket, true)
  assert.equal(
    (await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status,
    'approved',
  )
  await runDueActions(scope.workspaceId)
  const wakeup = await prisma.wakeup.findFirstOrThrow({
    where: { sourceId: `action:${planned.actionId}:run` },
  })
  assert.match(wakeup.note, /Ada approved/)
  assert.match(wakeup.note, /Inviting your team takes one click\./)
})

test('a draft nobody approved in time expires, and the thread is told once', { skip }, async () => {
  const planned = (await call(mainId, {
    name: 'plan_action',
    at: inMinutes(120),
    title: 'Post: billing',
    instructions: 'Publish',
    draft: 'One invoice.',
  })) as { actionId: string }
  const action = await due(planned.actionId, { approveBy: new Date(Date.now() - 1_000) })
  await Promise.all([runDueActions(scope.workspaceId), runDueActions(scope.workspaceId)])
  assert.equal(
    (await prisma.initiativeAction.findUniqueOrThrow({ where: { id: planned.actionId } })).status,
    'expired',
  )
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: action.ticketId! } })
  assert.equal(ticket.status, 'resolved')
  const notes = await prisma.wakeup.findMany({
    where: { sourceId: { startsWith: `action:${planned.actionId}` } },
  })
  assert.deepEqual(
    notes.map((n) => n.sourceId),
    [`action:${planned.actionId}:expired`],
  )
  // Once past its deadline, it can't be approved any more.
  await assert.rejects(
    decideMissionAction(scoped(scope), member(), ticket, true),
    /already|deadline/,
  )
  // Even past its time, it never runs.
  await due(planned.actionId, { dueAt: new Date(Date.now() - 1_000) })
  await runDueActions(scope.workspaceId)
  assert.equal(
    await prisma.wakeup.count({ where: { sourceId: `action:${planned.actionId}:run` } }),
    0,
  )
})

test('approving after the deadline, before the job ran, is refused', { skip }, async () => {
  const planned = (await call(mainId, {
    name: 'plan_action',
    at: inMinutes(120),
    title: 'Post: late',
    instructions: 'Publish',
    draft: 'Late.',
  })) as { actionId: string }
  const action = await due(planned.actionId, { approveBy: new Date(Date.now() - 1_000) })
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: action.ticketId! } })
  await assert.rejects(decideMissionAction(scoped(scope), member(), ticket, true), /deadline/)
  assert.equal(
    (await prisma.initiativeAction.findUniqueOrThrow({ where: { id: planned.actionId } })).status,
    'awaiting_approval',
  )
})

test('a declined draft does not go, and its thread hears why', { skip }, async () => {
  const planned = (await call(mainId, {
    name: 'plan_action',
    at: inMinutes(120),
    title: 'Post: pricing',
    instructions: 'Publish',
    draft: 'Prices.',
  })) as { actionId: string }
  const action = await prisma.initiativeAction.findUniqueOrThrow({
    where: { id: planned.actionId },
  })
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: action.ticketId! } })
  await decideMissionAction(scoped(scope), member(), ticket, false, 'Too salesy')
  assert.equal(
    (await prisma.initiativeAction.findUniqueOrThrow({ where: { id: planned.actionId } })).status,
    'declined',
  )
  const note = await prisma.wakeup.findFirstOrThrow({
    where: { sourceId: `action:${planned.actionId}:declined` },
  })
  assert.match(note.note, /Ada declined its draft \("Too salesy"\)/)
})

test('outputs and the number are recorded, and the views read them', { skip }, async () => {
  const output = (await call(mainId, {
    name: 'record_output',
    kind: 'post',
    channel: 'linkedin',
    url: 'https://www.linkedin.com/feed/update/1',
    summary: 'Roles post',
    metrics: { impressions: 100 },
  })) as { outputId: string }
  await call(mainId, { name: 'record_output', outputId: output.outputId, metrics: { likes: 7 } })
  const row = await prisma.initiativeOutput.findUniqueOrThrow({ where: { id: output.outputId } })
  assert.deepEqual(row.metrics, { impressions: 100, likes: 7 })
  const missing = await call(mainId, { name: 'record_output', summary: 'No channel' })
  assert.match((missing as { error: string }).error, /channel/)
  await call(mainId, { name: 'record_number', value: 1200 })
  await call(mainId, { name: 'record_number', value: 1250, note: 'LinkedIn analytics' })

  // An action to approve within the week, and the routine's runs.
  const planned = (await call(mainId, {
    name: 'plan_action',
    at: inMinutes(24 * 60),
    title: 'Post: week',
    instructions: 'Publish',
    draft: 'Week.',
  })) as { actionId: string }
  const [mission] = await listMissions(scoped(scope), member())
  assert.ok(mission)
  assert.equal(mission.id, missionId)
  assert.equal(mission.number?.source, 'declared')
  assert.deepEqual(
    mission.number?.series.map((p) => p.value),
    [1200, 1250],
  )
  assert.equal(mission.last?.kind, 'output')
  assert.ok(mission.needs.some((n) => n.reason === 'approval' && n.title === 'Post: week'))
  assert.equal(mission.routines.length, 1)
  assert.ok(mission.next)

  const week = await missionWeek(scoped(scope), new Date())
  const kinds = new Set(week.items.map((i) => i.kind))
  assert.ok(kinds.has('routine'))
  assert.ok(kinds.has('action'))
  assert.ok(week.items.some((i) => i.kind === 'approval' && i.actionId === planned.actionId))
  assert.deepEqual(
    week.items.map((i) => i.at),
    [...week.items.map((i) => i.at)].sort(),
  )
})

test('without the feature, the tools refuse and the spec has no mission', { skip }, async () => {
  const other = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'No missions' },
  })
  const result = await handleInitiativeCall(
    scoped({ ...scope, workspaceId: other.id }),
    { ...scope, workspaceId: other.id },
    { id: mainId, startedByMemberId: ids.member, workspaceId: other.id },
    maya,
    { name: 'list_actions' },
  )
  assert.match((result as { error: string }).error, /not open/)
})

test(
  'another member deciding a draft takes part in the thread, through the tickets route',
  { skip },
  async () => {
    // Bob, an admin: his decision makes the thread one several people ask in, so Ada's own Apps no
    // longer answer what he decided (thread-spec.ts askedBy).
    const bob = { user: `user-missions-bob-${id}`, member: `mem-missions-bob-${id}` }
    await prisma.user.create({
      data: { id: bob.user, name: 'Bob', email: `${bob.user}@example.com` },
    })
    await prisma.member.create({
      data: { id: bob.member, organizationId: ids.organization, userId: bob.user, role: 'admin' },
    })
    try {
      const home = await thread({ initiativeId: missionId, askedByMemberId: ids.member })
      const planned = (await call(home.id, {
        name: 'plan_action',
        at: inMinutes(120),
        title: 'Post: asked',
        instructions: 'Publish',
        draft: 'Asked.',
      })) as { actionId: string }
      const action = await prisma.initiativeAction.findUniqueOrThrow({
        where: { id: planned.actionId },
      })
      await resolveTicket(
        { ...scope, userId: bob.user, memberId: bob.member, role: 'admin' },
        action.ticketId!,
        { approved: true },
      )
      assert.equal(
        (await prisma.initiativeAction.findUniqueOrThrow({ where: { id: action.id } })).status,
        'planned',
      )
      assert.equal(
        (await prisma.session.findUniqueOrThrow({ where: { id: home.id } })).askedByMemberId,
        '*',
      )
    } finally {
      await prisma.member.deleteMany({ where: { id: bob.member } })
      await prisma.user.deleteMany({ where: { id: bob.user } })
    }
  },
)

test(
  'an action planned by a teammate absent from the mission’s thread goes to that thread’s teammate',
  { skip },
  async () => {
    // Cody works in a sub-thread of Maya's mission thread, where he has no seat.
    const cody = await prisma.teammate.create({ data: { ...scope, name: 'Cody' } })
    const child = await prisma.session.create({
      data: {
        ...scope,
        teammateId: cody.id,
        startedByMemberId: ids.member,
        computerId,
        title: 'Cody’s part',
        status: 'idle',
        origin: 'child',
        parentId: mainId,
        parentTeammateId: maya.id,
      } as never,
    })
    await prisma.threadTeammate.create({
      data: { ...scope, sessionId: child.id, teammateId: cody.id },
    })
    const planned = (await handleInitiativeCall(
      scoped(scope),
      scope,
      { id: child.id, startedByMemberId: ids.member, workspaceId: scope.workspaceId },
      { id: cody.id, name: 'Cody' },
      { name: 'plan_action', at: inMinutes(30), title: 'Post: Cody', instructions: 'Publish' },
    )) as { actionId: string; threadId: string }
    assert.equal(planned.threadId, mainId)
    await due(planned.actionId, { dueAt: new Date(Date.now() - 1_000) })
    await runDueActions(scope.workspaceId)
    const wakeup = await prisma.wakeup.findFirstOrThrow({
      where: { sourceId: `action:${planned.actionId}:run` },
    })
    assert.equal(wakeup.teammateId, maya.id)
    assert.notEqual(wakeup.status, 'missed')
  },
)

test('Next is what will still happen, not a declined or expired action', { skip }, async () => {
  const [before] = await listMissions(scoped(scope), member())
  const declined = (await call(mainId, {
    name: 'plan_action',
    at: inMinutes(10),
    title: 'Post: soonest, declined',
    instructions: 'Publish',
    draft: 'No.',
    approveBy: inMinutes(6),
  })) as { actionId: string }
  const action = await prisma.initiativeAction.findUniqueOrThrow({
    where: { id: declined.actionId },
  })
  const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: action.ticketId! } })
  await decideMissionAction(scoped(scope), member(), ticket, false)
  const [after] = await listMissions(scoped(scope), member())
  assert.notEqual(after?.next?.actionId, declined.actionId)
  assert.equal(after?.next?.key, before?.next?.key)
})

/** A teammate's call from a thread, as schedules.ts passes it: the whole row. */
const callFrom = async (sessionId: string, op: Parameters<typeof handleInitiativeCall>[4]) =>
  handleInitiativeCall(
    scoped(scope),
    scope,
    await prisma.session.findUniqueOrThrow({ where: { id: sessionId } }),
    maya,
    op,
  )

test(
  'a teammate makes a mission of the thread the work was delegated in, once',
  { skip },
  async () => {
    const delegated = await thread({})
    const made = (await callFrom(delegated.id, {
      name: 'create_mission',
      title: 'Answer Reddit',
      objective: 'Help on invoicing questions',
      metric: { label: 'Upvotes' },
    })) as { missionId: string }
    assert.ok(made.missionId)
    assert.equal(await missionIdOfThread(scoped(scope), delegated.id), made.missionId)
    const mission = await prisma.initiative.findUniqueOrThrow({ where: { id: made.missionId } })
    assert.equal(mission.teammateId, maya.id)
    assert.equal(mission.metricLabel, 'Upvotes')
    // Again: it already is one.
    const again = await callFrom(delegated.id, {
      name: 'create_mission',
      title: 'Twice',
      objective: 'No',
    })
    assert.match(
      (again as { error: string }).error,
      /already works for the mission "Answer Reddit"/,
    )
    // Not from a sub-thread.
    const child = await thread({
      origin: 'child',
      parentId: delegated.id,
      parentTeammateId: maya.id,
    })
    const fromChild = await callFrom(child.id, {
      name: 'create_mission',
      title: 'Sub',
      objective: 'No',
    })
    assert.match((fromChild as { error: string }).error, /already works|at the top/)
    const loose = await thread({})
    const looseChild = await thread({
      origin: 'child',
      parentId: loose.id,
      parentTeammateId: maya.id,
    })
    const refused = await callFrom(looseChild.id, {
      name: 'create_mission',
      title: 'Sub',
      objective: 'No',
    })
    assert.match((refused as { error: string }).error, /at the top/)

    // Changed, its number dropped, then archived: its thread no longer carries it.
    await callFrom(delegated.id, {
      name: 'update_mission',
      objective: 'Help, and say we are an AI',
      metric: null,
    })
    const changedRow = await prisma.initiative.findUniqueOrThrow({ where: { id: made.missionId } })
    assert.equal(changedRow.objective, 'Help, and say we are an AI')
    assert.equal(changedRow.metricLabel, null)
    await callFrom(delegated.id, { name: 'update_mission', archive: true })
    assert.equal(
      await threadInitiative(scoped(scope), {
        id: delegated.id,
        workspaceId: scope.workspaceId,
        startedByMemberId: ids.member,
      }),
      null,
    )
  },
)

test('a member makes a mission from the page with threads they started', { skip }, async () => {
  const mine = await thread({})
  const other = await thread({})
  const made = await createMission(scoped(scope), member(), {
    title: 'X workflow',
    objective: 'Two posts a day',
    teammateId: maya.id,
    metric: { label: 'Followers', unit: null, target: 500 },
    threadIds: [mine.id],
  })
  assert.equal(await missionIdOfThread(scoped(scope), mine.id), made.id)
  const [row] = (await listMissions(scoped(scope), member())).filter((m) => m.id === made.id)
  assert.deepEqual(row?.metric, { label: 'Followers', unit: null, target: 500 })
  assert.deepEqual(
    row?.threads.map((t) => t.id),
    [mine.id],
  )

  // Its whole set of threads: one added, one taken out.
  await updateMission(scoped(scope), member(), made.id, { threadIds: [other.id] })
  assert.equal(await missionIdOfThread(scoped(scope), other.id), made.id)
  assert.equal(await missionIdOfThread(scoped(scope), mine.id), null)

  // A sub-thread belongs to its parent's mission.
  const child = await thread({ origin: 'child', parentId: other.id, parentTeammateId: maya.id })
  await assert.rejects(
    updateMission(scoped(scope), member(), made.id, { threadIds: [other.id, child.id] }),
    /parent/,
  )
  // A member gives only threads they started: another's is refused.
  const carol = { user: `user-missions-carol-${id}`, member: `mem-missions-carol-${id}` }
  await prisma.user.create({
    data: { id: carol.user, name: 'Carol', email: `${carol.user}@example.com` },
  })
  await prisma.member.create({
    data: {
      id: carol.member,
      organizationId: ids.organization,
      userId: carol.user,
      role: 'member',
    },
  })
  try {
    const asCarol = {
      ...scope,
      userId: carol.user,
      memberId: carol.member,
      role: 'member' as const,
    }
    await assert.rejects(
      createMission(scoped(scope), asCarol, {
        title: 'Not hers',
        objective: 'No',
        teammateId: maya.id,
        threadIds: [mine.id],
      }),
      /you started/,
    )
  } finally {
    await prisma.member.deleteMany({ where: { id: carol.member } })
    await prisma.user.deleteMany({ where: { id: carol.user } })
  }

  // Archived, it leaves the page.
  await updateMission(scoped(scope), member(), made.id, { archived: true })
  assert.ok(!(await listMissions(scoped(scope), member())).some((m) => m.id === made.id))
})

test(
  'a mission is its member’s: another changes nothing, an admin may only archive it',
  { skip },
  async () => {
    const bob = { user: `user-missions-bob2-${id}`, member: `mem-missions-bob2-${id}` }
    await prisma.user.create({
      data: { id: bob.user, name: 'Bob', email: `${bob.user}@example.com` },
    })
    await prisma.member.create({
      data: { id: bob.member, organizationId: ids.organization, userId: bob.user, role: 'admin' },
    })
    try {
      const adas = await thread({ askedByMemberId: ids.member })
      const made = await createMission(scoped(scope), member(), {
        title: 'Ada’s',
        objective: 'Hers',
        teammateId: maya.id,
        threadIds: [adas.id],
      })
      const asBob = { ...scope, userId: bob.user, memberId: bob.member, role: 'admin' as const }
      // Bob's words would reach Maya in Ada's thread, on Ada's accounts: refused, even to an admin.
      await assert.rejects(
        updateMission(scoped(scope), asBob, made.id, { objective: 'Post every hour' }),
        /Only the member whose mission it is/,
      )
      await assert.rejects(
        updateMission(scoped(scope), asBob, made.id, { archived: true, objective: 'And this' }),
        /Only the member whose mission it is/,
      )
      assert.equal(
        (await prisma.initiative.findUniqueOrThrow({ where: { id: made.id } })).objective,
        'Hers',
      )
      // Archiving only holds its work back: an admin may.
      await updateMission(scoped(scope), asBob, made.id, { archived: true })
      assert.ok((await prisma.initiative.findUniqueOrThrow({ where: { id: made.id } })).archivedAt)
      // A teammate's mission is its thread's member's.
      const delegated = await thread({})
      const byMaya = (await callFrom(delegated.id, {
        name: 'create_mission',
        title: 'Maya’s',
        objective: 'For Ada',
      })) as { missionId: string }
      assert.equal(
        (await prisma.initiative.findUniqueOrThrow({ where: { id: byMaya.missionId } }))
          .createdByMemberId,
        ids.member,
      )
    } finally {
      await prisma.member.deleteMany({ where: { id: bob.member } })
      await prisma.user.deleteMany({ where: { id: bob.user } })
    }
  },
)

test(
  'taking a thread out of a mission leaves it alone once another change moved it',
  { skip },
  async () => {
    const a = await createMission(scoped(scope), member(), {
      title: 'A',
      objective: 'A',
      teammateId: maya.id,
      threadIds: [],
    })
    const b = await createMission(scoped(scope), member(), {
      title: 'B',
      objective: 'B',
      teammateId: maya.id,
      threadIds: [],
    })
    const moved = await thread({ initiativeId: a.id })
    const planned = (await call(moved.id, {
      name: 'plan_action',
      at: inMinutes(60),
      title: 'Post: raced',
      instructions: 'Publish',
    })) as { actionId: string }
    // Another change moved it to B and committed, after this one read it in A.
    await prisma.session.update({ where: { id: moved.id }, data: { initiativeId: b.id } })
    await prisma.initiativeAction.update({
      where: { id: planned.actionId },
      data: { initiativeId: b.id },
    })
    await scoped(scope).$transaction((tx) =>
      moveThreads(tx, scope.workspaceId, [moved.id], null, a.id),
    )
    assert.equal(
      (await prisma.session.findUniqueOrThrow({ where: { id: moved.id } })).initiativeId,
      b.id,
    )
    assert.equal(
      (await prisma.initiativeAction.findUniqueOrThrow({ where: { id: planned.actionId } })).status,
      'planned',
    )
  },
)

test(
  'a thread moving between missions takes its routines and plan; out of any, its plan stops',
  { skip },
  async () => {
    const from = await createMission(scoped(scope), member(), {
      title: 'From',
      objective: 'A',
      teammateId: maya.id,
      threadIds: [],
    })
    const to = await createMission(scoped(scope), member(), {
      title: 'To',
      objective: 'B',
      teammateId: maya.id,
      threadIds: [],
    })
    const moving = await thread({})
    await updateMission(scoped(scope), member(), from.id, { threadIds: [moving.id] })
    const routine = await prisma.schedule.create({
      data: {
        ...scope,
        teammateId: maya.id,
        title: 'Daily',
        instructions: 'Comment',
        cron: '0 9 * * *',
        timezone: 'Europe/Paris',
        ownerMemberId: ids.member,
        parentSessionId: moving.id,
        initiativeId: from.id,
        nextRunAt: new Date(Date.now() + 3_600_000),
      },
    })
    const planned = (await call(moving.id, {
      name: 'plan_action',
      at: inMinutes(60),
      title: 'Post: moving',
      instructions: 'Publish',
      draft: 'Moving.',
    })) as { actionId: string }
    await updateMission(scoped(scope), member(), to.id, { threadIds: [moving.id] })
    assert.equal(
      (await prisma.schedule.findUniqueOrThrow({ where: { id: routine.id } })).initiativeId,
      to.id,
    )
    assert.equal(
      (await prisma.initiativeAction.findUniqueOrThrow({ where: { id: planned.actionId } }))
        .initiativeId,
      to.id,
    )
    // Its plan still answers in its new mission.
    assert.ok(
      !('error' in (await call(moving.id, { name: 'cancel_action', actionId: planned.actionId }))),
    )

    const second = (await call(moving.id, {
      name: 'plan_action',
      at: inMinutes(60),
      title: 'Post: leaving',
      instructions: 'Publish',
      draft: 'Leaving.',
    })) as { actionId: string }
    await updateMission(scoped(scope), member(), to.id, { threadIds: [] })
    const left = await prisma.initiativeAction.findUniqueOrThrow({ where: { id: second.actionId } })
    assert.equal(left.status, 'cancelled')
    assert.equal(
      (await prisma.ticket.findUniqueOrThrow({ where: { id: left.ticketId! } })).status,
      'resolved',
    )
    assert.equal(
      (await prisma.schedule.findUniqueOrThrow({ where: { id: routine.id } })).initiativeId,
      null,
    )
  },
)

test('an archived mission stops: its plan cancelled, its routines paused', { skip }, async () => {
  const kept = await thread({})
  const made = await createMission(scoped(scope), member(), {
    title: 'Ending',
    objective: 'Over soon',
    teammateId: maya.id,
    threadIds: [kept.id],
  })
  const routine = await prisma.schedule.create({
    data: {
      ...scope,
      teammateId: maya.id,
      title: 'Weekly',
      instructions: 'Sum up',
      cron: '0 17 * * 0',
      timezone: 'Europe/Paris',
      ownerMemberId: ids.member,
      parentSessionId: kept.id,
      nextRunAt: new Date(Date.now() + 3_600_000),
    },
  })
  const planned = (await call(kept.id, {
    name: 'plan_action',
    at: inMinutes(60),
    title: 'Post: approved',
    instructions: 'Publish',
  })) as { actionId: string }
  await updateMission(scoped(scope), member(), made.id, { archived: true })
  assert.equal(
    (await prisma.initiativeAction.findUniqueOrThrow({ where: { id: planned.actionId } })).status,
    'cancelled',
  )
  const paused = await prisma.schedule.findUniqueOrThrow({ where: { id: routine.id } })
  assert.ok(paused.pausedAt)
  assert.equal(paused.nextRunAt, null)
})
