// Missions (docs/missions.md), named Initiative in code: ongoing work a member delegates to a
// teammate. Behind the `missions` feature, read on the thread's starter as Tools are.
//
// A mission owns threads (Session.initiativeId) and routines (Schedule.initiativeId, or a routine
// reporting to one of its threads); a sub-thread or a routine's run belongs to its parent's or its
// routine's. Its plan is data: planned actions, each prompted into its thread at its time as a
// wake-up (sourceId action:<id>:run), one with a draft only once a person approved it before its
// deadline, through an approval ticket. What went out is data too (outputs), and its number is a
// goal's measurements in one of its threads, else the values its teammate declares.
import {
  ACTION_SOURCE,
  ACTIONS_PER_MISSION,
  actionDroppedMessage,
  actionMessage,
  actionSourceId,
  actionTimes,
  type ActionNoteKind,
  type MissionAgendaItem,
  type CreateMission,
  type MissionMetric,
  type UpdateMission,
  type MissionNeed,
  type MissionNumber,
  type MissionOutput,
  type MissionRow,
  type MissionWeek,
  nextRuns,
  OutputKind,
  OutputMetrics,
  type ScheduleOperation,
  WEEK_DAYS,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { mayWrite } from './account-sharing.js'
import { audit } from './audit.js'
import { board } from './board.js'
import { reportOf } from './children.js'
import { Prisma, prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { featuresOfMember } from './features.js'
import { hubs, scheduleUpdated, threadUpdated } from './hub.js'
import { noteAsker } from './thread-spec.js'
import type { WorkspaceScope } from './scope.js'
import { fireNow } from './wakeups.js'

type InitiativeOperation = Extract<
  ScheduleOperation,
  {
    name:
      | 'create_mission'
      | 'update_mission'
      | 'plan_action'
      | 'list_actions'
      | 'cancel_action'
      | 'record_output'
      | 'record_number'
  }
>

const OPERATIONS = new Set([
  'create_mission',
  'update_mission',
  'plan_action',
  'list_actions',
  'cancel_action',
  'record_output',
  'record_number',
])

export const isInitiativeOperation = (op: ScheduleOperation): op is InitiativeOperation =>
  OPERATIONS.has(op.name)

const DAY = 24 * 60 * 60_000
/** Days of a mission's number the Missions page draws. */
const SERIES_DAYS = 30
/** Outputs a mission's row carries. */
const OUTPUTS_SHOWN = 5

/** A thread as missions read it: where it hangs and what it belongs to. */
type ThreadLink = {
  id: string
  initiativeId: string | null
  parentId: string | null
  scheduleId: string | null
  parent: {
    id: string
    initiativeId: string | null
    schedule: { initiativeId: string | null } | null
  } | null
  schedule: { initiativeId: string | null; parentSessionId: string | null } | null
}

const LINK_SELECT = {
  id: true,
  initiativeId: true,
  parentId: true,
  scheduleId: true,
  parent: {
    select: { id: true, initiativeId: true, schedule: { select: { initiativeId: true } } },
  },
  schedule: { select: { initiativeId: true, parentSessionId: true } },
} as const

/**
 * The mission a thread belongs to, by its id: its own, else its parent's (a sub-thread, a run
 * reporting there), else its routine's (a run, or its parent's run).
 */
export function initiativeIdOf(thread: ThreadLink) {
  return (
    thread.initiativeId ??
    thread.parent?.initiativeId ??
    thread.schedule?.initiativeId ??
    thread.parent?.schedule?.initiativeId ??
    null
  )
}

/**
 * The thread a mission's action runs in, planned from this one: the thread itself when it stands at
 * the top, its parent for a sub-thread or a run reporting there; a run of its own goes to the
 * mission's first thread, as it ends with its run.
 */
async function homeThreadOf(db: ScopedDb, thread: ThreadLink, initiativeId: string) {
  if (thread.parentId) return thread.parentId
  if (!thread.scheduleId) return thread.id
  const main = await db.session.findFirst({
    where: { initiativeId, parentId: null, scheduleId: null, archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  return main?.id ?? thread.id
}

/** A mission's number, as columns: none clears it. */
const metricData = (metric: MissionMetric | null) => ({
  metricLabel: metric?.label ?? null,
  metricUnit: metric?.unit ?? null,
  metricTarget: metric?.target ?? null,
})

/** The mission a thread belongs to, by id, or null. */
export async function missionIdOfThread(db: ScopedDb, sessionId: string) {
  const link = await db.session.findFirst({ where: { id: sessionId }, select: LINK_SELECT })
  return link ? initiativeIdOf(link) : null
}

/** The mission of a thread, for its spec: only for a starter who has the feature. */
export async function threadInitiative(
  db: ScopedDb,
  thread: { id: string; workspaceId: string; startedByMemberId: string },
) {
  const link = await db.session.findFirst({ where: { id: thread.id }, select: LINK_SELECT })
  const id = link && initiativeIdOf(link)
  if (!id) return null
  if (!(await featuresOfMember(thread.startedByMemberId, thread.workspaceId)).has('missions'))
    return null
  const mission = await db.initiative.findFirst({
    where: { id, archivedAt: null },
    select: {
      id: true,
      title: true,
      objective: true,
      metricLabel: true,
      metricUnit: true,
      teammate: { select: { id: true, name: true } },
    },
  })
  if (!mission) return null
  return {
    id: mission.id,
    title: mission.title,
    objective: mission.objective,
    teammate: mission.teammate,
    number: mission.metricLabel ? { label: mission.metricLabel, unit: mission.metricUnit } : null,
  }
}

const changed = (scope: Scope, sessionId: string, status = 'idle') =>
  void hubs.get(scope.workspaceId).broadcast(threadUpdated(sessionId, status))

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null

type ActionRow = {
  id: string
  title: string
  status: string
  dueAt: Date
  approveBy: Date | null
  draft: string | null
  sessionId: string
}

/** What a teammate is told of an action. */
const actionBrief = (a: ActionRow) => ({
  actionId: a.id,
  title: a.title,
  status: a.status,
  at: a.dueAt.toISOString(),
  ...(a.approveBy ? { approveBy: a.approveBy.toISOString() } : {}),
  threadId: a.sessionId,
})

/** The approval ticket's payload: the action it decides (decide.ts sends it here). */
export type MissionActionPayload = {
  missionAction: {
    actionId: string
    missionId: string
    mission: string
    title: string
    dueAt: string
    approveBy: string
  }
  /** The draft, shown on the ticket. */
  draft: string
  teammateId: string
}

/** A teammate's mission tools, from a thread of a mission (docs/missions.md). */
export async function handleInitiativeCall(
  db: ScopedDb,
  scope: Scope,
  session: {
    id: string
    startedByMemberId: string
    workspaceId: string
    playbookRunId?: string | null
    origin?: string
    parentId?: string | null
    projectId?: string | null
  },
  teammate: { id: string; name: string },
  op: InitiativeOperation,
): Promise<object | { error: string }> {
  if (!(await featuresOfMember(session.startedByMemberId, scope.workspaceId)).has('missions'))
    return { error: 'Missions are not open to this workspace.' }
  const link = await db.session.findFirst({ where: { id: session.id }, select: LINK_SELECT })
  const missionId = link && initiativeIdOf(link)
  const mission = missionId
    ? await db.initiative.findFirst({ where: { id: missionId, archivedAt: null } })
    : null
  if (op.name === 'create_mission') {
    if (mission)
      return {
        error: `This thread already works for the mission "${mission.title}": change it with update_mission.`,
      }
    if (session.origin !== 'member' || session.parentId || session.playbookRunId || !link)
      return {
        error:
          'A mission is made from the thread a person delegated the work in, at the top: not from a ' +
          'sub-thread, a routine’s run or a playbook’s thread.',
      }
    const created = await db
      .$transaction(async (tx) => {
        const row = await tx.initiative.create({
          data: {
            teammateId: teammate.id,
            projectId: session.projectId ?? null,
            title: op.title,
            objective: op.objective,
            metricLabel: op.metric?.label ?? null,
            metricUnit: op.metric?.unit ?? null,
            metricTarget: op.metric?.target ?? null,
            createdByTeammateId: teammate.id,
          } as never,
        })
        // Kept only while the thread still belongs to none: two calls at once make one mission of it.
        const { count } = await tx.session.updateMany({
          where: { id: session.id, initiativeId: null },
          data: { initiativeId: row.id },
        })
        if (!count)
          throw new HTTPException(409, { message: 'This thread joined a mission meanwhile' })
        return row
      })
      .catch((error: unknown) => {
        if (error instanceof HTTPException) return { error: error.message }
        throw error
      })
    if ('error' in created) return created
    await audit({
      ...scope,
      actor: { type: 'teammate', id: teammate.id },
      action: 'mission.created',
      target: { type: 'thread', id: session.id },
      data: { missionId: created.id },
    })
    changed(scope, session.id)
    return {
      missionId: created.id,
      title: created.title,
      next:
        'Made. This thread, its sub-threads and its routines belong to it now, and so does what you ' +
        'start from here. Tell the person in one line that it is on the Missions page.',
    }
  }
  if (!link || !mission)
    return {
      error:
        'This thread belongs to no mission: there is nothing to plan or record here. Just do the work.',
    }
  const actor = { type: 'teammate' as const, id: teammate.id }

  if (op.name === 'update_mission') {
    const updated = await db.initiative.update({
      where: { id: mission.id },
      data: {
        ...(op.title ? { title: op.title } : {}),
        ...(op.objective ? { objective: op.objective } : {}),
        ...(op.metric !== undefined ? metricData(op.metric) : {}),
        ...(op.archive ? { archivedAt: new Date() } : {}),
      },
    })
    // Its work over: its plan cancelled, its routines paused (retireMission).
    if (op.archive)
      schedulesChanged(
        scope,
        (await db.$transaction((tx) => retireMission(tx, mission.id))).schedules,
      )
    await audit({
      ...scope,
      actor,
      action: op.archive ? 'mission.archived' : 'mission.updated',
      target: { type: 'thread', id: session.id },
      data: { missionId: mission.id },
    })
    changed(scope, session.id)
    return {
      missionId: updated.id,
      title: updated.title,
      objective: updated.objective,
      archived: !!updated.archivedAt,
    }
  }

  if (op.name === 'plan_action') {
    const times = actionTimes(op)
    if (typeof times === 'string') return { error: times }
    const pending = await db.initiativeAction.count({
      where: { initiativeId: mission.id, status: { in: ['planned', 'awaiting_approval'] } },
    })
    if (pending >= ACTIONS_PER_MISSION)
      return {
        error:
          `The mission already holds ${pending} planned actions, the most it does. Cancel one ` +
          '(list_actions shows them), or keep the rest of the plan in its files.',
      }
    const home = await homeThreadOf(db, link, mission.id)
    const action = await db.$transaction(async (tx) => {
      const created = await tx.initiativeAction.create({
        data: {
          initiativeId: mission.id,
          sessionId: home,
          teammateId: teammate.id,
          title: op.title,
          instructions: op.instructions,
          draft: op.draft ?? null,
          dueAt: times.at,
          approveBy: times.approveBy,
          status: op.draft ? 'awaiting_approval' : 'planned',
        } as never,
      })
      if (!op.draft || !times.approveBy) return created
      const payload: MissionActionPayload = {
        missionAction: {
          actionId: created.id,
          missionId: mission.id,
          mission: mission.title,
          title: op.title,
          dueAt: times.at.toISOString(),
          approveBy: times.approveBy.toISOString(),
        },
        draft: op.draft,
        teammateId: teammate.id,
      }
      const ticket = await tx.ticket.create({
        data: {
          sessionId: home,
          type: 'approval',
          title: `${teammate.name}: approve "${op.title}"`,
          payload: payload as never,
        } as never,
      })
      return tx.initiativeAction.update({
        where: { id: created.id },
        data: { ticketId: ticket.id },
      })
    })
    await audit({
      ...scope,
      actor,
      action: 'mission.action_planned',
      target: { type: 'thread', id: home },
      data: { actionId: action.id, missionId: mission.id, dueAt: action.dueAt.toISOString() },
    })
    changed(scope, home)
    return {
      ...actionBrief(action),
      next: action.approveBy
        ? 'Planned. Its draft waits for a person’s approval, on a ticket in the mission’s thread and on the ' +
          'Missions page; unapproved by approveBy, it does not go. At its time you are prompted in the ' +
          'mission’s thread with its instructions and the approved draft. Do not also open a ticket for it.'
        : 'Planned. At its time you are prompted in the mission’s thread with its instructions. Do not set a ' +
          'wake-up for it too.',
    }
  }

  if (op.name === 'list_actions') {
    const [open, past] = await Promise.all([
      db.initiativeAction.findMany({
        where: { initiativeId: mission.id, status: { in: ['planned', 'awaiting_approval'] } },
        orderBy: { dueAt: 'asc' },
      }),
      db.initiativeAction.findMany({
        where: {
          initiativeId: mission.id,
          status: { notIn: ['planned', 'awaiting_approval'] },
        },
        orderBy: { dueAt: 'desc' },
        take: 10,
      }),
    ])
    return {
      mission: { id: mission.id, title: mission.title },
      planned: open.map(actionBrief),
      recent: past.map(actionBrief),
    }
  }

  if (op.name === 'cancel_action') {
    const action = await db.initiativeAction.findFirst({
      where: { id: op.actionId, initiativeId: mission.id },
    })
    if (!action) return { error: 'No action of this mission has that id; list_actions shows them' }
    const cancelled = await db.$transaction(async (tx) => {
      const { count } = await tx.initiativeAction.updateMany({
        where: { id: action.id, status: { in: ['planned', 'awaiting_approval'] } },
        data: { status: 'cancelled' },
      })
      if (count && action.ticketId)
        await tx.ticket.updateMany({
          where: { id: action.ticketId, status: 'open' },
          data: { status: 'resolved', resolvedAt: new Date() },
        })
      return count === 1
    })
    if (!cancelled) return { error: `That action is ${action.status} already: nothing to cancel` }
    await audit({
      ...scope,
      actor,
      action: 'mission.action_cancelled',
      target: { type: 'thread', id: action.sessionId },
      data: { actionId: action.id },
    })
    changed(scope, action.sessionId)
    return { cancelled: actionBrief({ ...action, status: 'cancelled' }) }
  }

  if (op.name === 'record_output') {
    if (op.outputId) {
      const output = await db.initiativeOutput.findFirst({
        where: { id: op.outputId, initiativeId: mission.id },
      })
      if (!output) return { error: 'No output of this mission has that id' }
      const metrics = op.metrics
        ? { ...OutputMetrics.catch({}).parse(output.metrics), ...op.metrics }
        : undefined
      const updated = await db.initiativeOutput.update({
        where: { id: output.id },
        data: {
          ...(op.url ? { url: op.url } : {}),
          ...(op.summary ? { summary: op.summary } : {}),
          ...(op.kind ? { kind: op.kind } : {}),
          ...(op.channel ? { channel: op.channel } : {}),
          ...(metrics ? { metrics, metricsAt: new Date() } : {}),
        },
      })
      return { outputId: updated.id, updated: true }
    }
    if (!op.channel || !op.summary)
      return { error: 'A new output needs its channel and a summary (and its url when it has one)' }
    const at = op.at ? new Date(op.at) : new Date()
    if (Number.isNaN(at.getTime())) return { error: `"${op.at}" is not an ISO 8601 time` }
    const action = op.actionId
      ? await db.initiativeAction.findFirst({
          where: { id: op.actionId, initiativeId: mission.id },
          select: { id: true },
        })
      : null
    if (op.actionId && !action) return { error: 'No action of this mission has that actionId' }
    const output = await db.initiativeOutput.create({
      data: {
        initiativeId: mission.id,
        sessionId: session.id,
        teammateId: teammate.id,
        actionId: action?.id ?? null,
        kind: op.kind ?? 'post',
        channel: op.channel,
        url: op.url ?? null,
        summary: op.summary,
        at,
        metrics: op.metrics ?? {},
        metricsAt: op.metrics ? new Date() : null,
      } as never,
    })
    changed(scope, session.id)
    return {
      outputId: output.id,
      next: 'Recorded on the mission. When you read its numbers later, call record_output again with this outputId and metrics.',
    }
  }

  // record_number
  if (!mission.metricLabel)
    return { error: 'This mission follows no number: there is nothing to record.' }
  const value = await db.initiativeValue.create({
    data: {
      initiativeId: mission.id,
      teammateId: teammate.id,
      value: op.value,
      note: op.note ?? null,
    } as never,
  })
  changed(scope, session.id)
  return { recorded: { label: mission.metricLabel, value: value.value, at: iso(value.at) } }
}

/**
 * A person's decision on an action's draft, from its approval ticket (decide.ts): approved, it runs
 * at its time; declined, it does not, and its teammate is told. Past its deadline, it can't be
 * approved any more: the minute's job lets it expire.
 */
export async function decideMissionAction(
  db: ScopedDb,
  scope: WorkspaceScope,
  ticket: { id: string; payload: unknown },
  approved: boolean,
  reason?: string,
) {
  const { missionAction } = ticket.payload as MissionActionPayload
  const now = new Date()
  const action = await db.initiativeAction.findFirst({ where: { id: missionAction.actionId } })
  if (!action) throw new HTTPException(404, { message: 'This action is gone' })
  const decided = await db.$transaction(async (tx) => {
    const { count } = await tx.initiativeAction.updateMany({
      where: {
        id: action.id,
        status: 'awaiting_approval',
        ...(approved ? { approveBy: { gt: now } } : {}),
      },
      data: {
        status: approved ? 'planned' : 'declined',
        decidedByMemberId: scope.memberId,
        decidedAt: now,
      },
    })
    if (!count) return null
    await tx.ticket.updateMany({
      where: { id: ticket.id, status: 'open' },
      data: {
        status: approved ? 'approved' : 'denied',
        resolvedByMemberId: scope.memberId,
        resolvedAt: now,
      },
    })
    // Declined: its thread hears it, kept with the decision so a restart tells it once.
    if (approved) return { wakeupId: null }
    const name = await tx.member.findFirst({
      where: { id: scope.memberId },
      select: { user: { select: { name: true } } },
    })
    const wakeup = await noteAction(tx, action, 'declined', {
      by: name?.user.name ?? null,
      reason: reason ?? null,
    })
    return { wakeupId: wakeup?.id ?? null }
  })
  if (!decided)
    throw new HTTPException(409, {
      message:
        action.status === 'awaiting_approval'
          ? 'Its deadline has passed: it no longer goes. Ask the teammate to plan it again.'
          : `This action is ${action.status} already`,
    })
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: approved ? 'mission.action_approved' : 'mission.action_declined',
    target: { type: 'ticket', id: ticket.id },
    data: { actionId: action.id },
  })
  if (decided.wakeupId) await fireNow(decided.wakeupId)
  changed(scope, action.sessionId)
}

/** A scoped client, or its transaction. */
type Tx = Pick<ScopedDb, 'wakeup' | 'threadTeammate' | 'session'>

/**
 * The wake-up that tells an action's thread about it: its run, or why it does not go. Keyed by
 * the action and the kind (Wakeup's unique sessionId and sourceId), so it is made once.
 */
async function noteAction(
  tx: Tx,
  action: {
    id: string
    organizationId: string
    workspaceId: string
    sessionId: string
    teammateId: string
    title: string
  },
  kind: ActionNoteKind,
  text: { note?: string; by?: string | null; reason?: string | null },
) {
  const sourceId = actionSourceId(action.id, kind)
  const existing = await tx.wakeup.findFirst({
    where: { sessionId: action.sessionId, sourceId },
    select: { id: true },
  })
  if (existing) return null
  return tx.wakeup.create({
    data: {
      organizationId: action.organizationId,
      workspaceId: action.workspaceId,
      sessionId: action.sessionId,
      teammateId: await recipientIn(tx, action.sessionId, action.teammateId),
      note:
        text.note ??
        actionDroppedMessage({
          title: action.title,
          kind: kind === 'declined' ? 'declined' : 'expired',
          by: text.by ?? null,
          reason: text.reason ?? null,
        }),
      wakeAt: new Date(),
      sourceId,
    } as never,
    select: { id: true },
  })
}

/**
 * Who an action's note goes to in its thread: the teammate that planned it while it is there, else
 * the thread's own teammate. Planned from a sub-thread or a run, the action goes to the mission's
 * thread, where its teammate may not be: a wake-up to someone absent is only marked missed
 * (wakeups.ts), and the action, already fired, would never run.
 */
async function recipientIn(tx: Tx, sessionId: string, teammateId: string) {
  const seat = await tx.threadTeammate.findFirst({
    where: { sessionId, teammateId, teammate: { archivedAt: null } },
    select: { teammateId: true },
  })
  if (seat) return seat.teammateId
  const thread = await tx.session.findFirst({
    where: { id: sessionId },
    select: { teammateId: true },
  })
  return thread?.teammateId ?? teammateId
}

/** Workspaces with an action due, or a draft whose deadline passed (src/jobs.ts). */
export async function dueActions(now = new Date()) {
  const rows = await prisma.initiativeAction.findMany({
    where: {
      OR: [
        { status: 'planned', dueAt: { lte: now } },
        { status: 'awaiting_approval', approveBy: { lte: now } },
      ],
    },
    distinct: ['workspaceId'],
    select: { workspaceId: true },
  })
  return rows.map((r) => r.workspaceId)
}

/**
 * Each minute: drafts nobody approved by their deadline expire, and their thread is told; actions
 * due are prompted into their thread. Each is claimed with its wake-up in one transaction, then
 * fired: a restart in between leaves the wake-up pending, which the wake-ups' job fires.
 */
export async function runDueActions(workspaceId?: string, now = new Date()) {
  const where = workspaceId ? { workspaceId } : {}
  const [expiring, due] = await Promise.all([
    prisma.initiativeAction.findMany({
      where: { ...where, status: 'awaiting_approval', approveBy: { lte: now } },
      orderBy: { approveBy: 'asc' },
      take: 100,
    }),
    prisma.initiativeAction.findMany({
      where: { ...where, status: 'planned', dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: 100,
      include: { initiative: { select: { title: true } } },
    }),
  ])
  for (const action of expiring) {
    const scope = { organizationId: action.organizationId, workspaceId: action.workspaceId }
    const wakeupId = await scoped(scope)
      .$transaction(async (tx) => {
        const { count } = await tx.initiativeAction.updateMany({
          where: { id: action.id, status: 'awaiting_approval' },
          data: { status: 'expired' },
        })
        if (!count) return null
        if (action.ticketId)
          await tx.ticket.updateMany({
            where: { id: action.ticketId, status: 'open' },
            data: { status: 'resolved', resolvedAt: now },
          })
        return (await noteAction(tx, action, 'expired', {}))?.id ?? null
      })
      .catch((error: unknown) => {
        console.error(`mission action ${action.id}: could not expire`, error)
        return null
      })
    if (wakeupId) await fireNow(wakeupId)
    changed(scope, action.sessionId)
  }
  for (const action of due) {
    const scope = { organizationId: action.organizationId, workspaceId: action.workspaceId }
    const approver = action.decidedByMemberId
      ? await prisma.member.findFirst({
          where: { id: action.decidedByMemberId },
          select: { user: { select: { name: true } } },
        })
      : null
    const late = now.getTime() - action.dueAt.getTime()
    const note = actionMessage({
      mission: action.initiative.title,
      title: action.title,
      instructions: `Action id: ${action.id}.\n\n${action.instructions}`,
      draft: action.draft,
      approvedBy: approver?.user.name ?? null,
      ...(late > 5 * 60_000 ? { lateMinutes: Math.round(late / 60_000) } : {}),
    })
    const wakeupId = await scoped(scope)
      .$transaction(async (tx) => {
        const { count } = await tx.initiativeAction.updateMany({
          where: { id: action.id, status: 'planned' },
          data: { status: 'fired', firedAt: now },
        })
        if (!count) return null
        return (await noteAction(tx, action, 'run', { note }))?.id ?? null
      })
      .catch((error: unknown) => {
        console.error(`mission action ${action.id}: could not run`, error)
        return null
      })
    if (wakeupId) await fireNow(wakeupId)
    changed(scope, action.sessionId)
  }
}

/** Whether a wake-up is a mission action's note: its text is the prompt itself. */
export const isActionSource = (sourceId: string | null | undefined) =>
  !!sourceId?.startsWith(ACTION_SOURCE)

// ---- The Missions page ----

const TEAMMATE = { select: { id: true, name: true } } as const

const outputView = (
  o: {
    id: string
    kind: string
    channel: string
    url: string | null
    summary: string
    at: Date
    metrics: unknown
    metricsAt: Date | null
    teammateId: string | null
  },
  names: Map<string, string>,
): MissionOutput => ({
  id: o.id,
  kind: OutputKind.catch('other').parse(o.kind),
  channel: o.channel,
  url: o.url,
  summary: o.summary,
  at: o.at.toISOString(),
  metrics: OutputMetrics.catch({}).parse(o.metrics),
  metricsAt: iso(o.metricsAt),
  teammate:
    o.teammateId && names.has(o.teammateId)
      ? { id: o.teammateId, name: names.get(o.teammateId)! }
      : null,
})

/** The workspace's missions, their threads and routines, for the views. */
async function missionsWithLinks(db: ScopedDb, ids?: string[]) {
  const missions = await db.initiative.findMany({
    where: { archivedAt: null, ...(ids ? { id: { in: ids } } : {}) },
    orderBy: { createdAt: 'asc' },
    include: {
      teammate: TEAMMATE,
      sessions: {
        where: { parentId: null },
        select: { id: true, title: true, status: true, archivedAt: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  const missionIds = missions.map((m) => m.id)
  const threadIds = missions.flatMap((m) => m.sessions.map((s) => s.id))
  // Its routines: its own, and those reporting to one of its threads.
  const schedules = missionIds.length
    ? await db.schedule.findMany({
        where: {
          OR: [
            { initiativeId: { in: missionIds } },
            ...(threadIds.length ? [{ parentSessionId: { in: threadIds } }] : []),
          ],
        },
        select: {
          id: true,
          title: true,
          cron: true,
          timezone: true,
          nextRunAt: true,
          pausedAt: true,
          initiativeId: true,
          parentSessionId: true,
          teammate: TEAMMATE,
        },
        orderBy: { createdAt: 'asc' },
      })
    : []
  const missionOfThread = new Map(
    missions.flatMap((m) => m.sessions.map((s) => [s.id, m.id] as const)),
  )
  const routinesOf = new Map<string, typeof schedules>()
  for (const s of schedules) {
    const id = s.initiativeId ?? (s.parentSessionId && missionOfThread.get(s.parentSessionId))
    if (!id) continue
    routinesOf.set(id, [...(routinesOf.get(id) ?? []), s])
  }
  return missions.map((m) => ({ ...m, routines: routinesOf.get(m.id) ?? [] }))
}

type Linked = Awaited<ReturnType<typeof missionsWithLinks>>[number]

/** The agenda of missions between two times: routines' runs, wake-ups, actions and approvals. */
async function agendaOf(
  db: ScopedDb,
  missions: Linked[],
  from: Date,
  to: Date,
): Promise<MissionAgendaItem[]> {
  const items: MissionAgendaItem[] = []
  const threadIds = missions.flatMap((m) =>
    m.sessions.filter((s) => !s.archivedAt).map((s) => s.id),
  )
  const missionOfThread = new Map(
    missions.flatMap((m) => m.sessions.map((s) => [s.id, m.id] as const)),
  )
  for (const m of missions)
    for (const r of m.routines) {
      if (r.pausedAt) continue
      let runs: Date[] = []
      try {
        runs = nextRuns(r.cron, r.timezone, 200, new Date(from.getTime() - 1)).filter((d) => d < to)
      } catch {
        continue
      }
      for (const at of runs)
        items.push({
          key: `routine:${r.id}:${at.toISOString()}`,
          kind: 'routine',
          at: at.toISOString(),
          title: r.title,
          missionId: m.id,
          threadId: r.parentSessionId,
          teammate: r.teammate,
        })
    }
  const [wakeups, actions] = await Promise.all([
    threadIds.length
      ? db.wakeup.findMany({
          where: {
            OR: [{ sessionId: { in: threadIds } }, { session: { parentId: { in: threadIds } } }],
            status: 'pending',
            kind: 'wakeup',
            wakeAt: { gte: from, lt: to },
            sourceId: null,
          },
          select: {
            id: true,
            note: true,
            wakeAt: true,
            sessionId: true,
            session: { select: { parentId: true } },
            teammate: TEAMMATE,
          },
        })
      : [],
    missions.length
      ? db.initiativeAction.findMany({
          where: {
            initiativeId: { in: missions.map((m) => m.id) },
            status: { not: 'cancelled' },
            OR: [{ dueAt: { gte: from, lt: to } }, { approveBy: { gte: from, lt: to } }],
          },
          orderBy: { dueAt: 'asc' },
        })
      : [],
  ])
  for (const w of wakeups) {
    const root = w.session.parentId ?? w.sessionId
    const missionId = missionOfThread.get(root)
    if (!missionId) continue
    items.push({
      key: `wakeup:${w.id}`,
      kind: 'wakeup',
      at: w.wakeAt.toISOString(),
      title: w.note.replace(/\s+/g, ' ').trim().slice(0, 200),
      missionId,
      threadId: w.sessionId,
      teammate: w.teammate,
    })
  }
  const names = new Map(missions.map((m) => [m.teammate.id, m.teammate.name]))
  const teammates = await teammateNames(
    db,
    actions.map((a) => a.teammateId),
  )
  for (const [id, name] of teammates) names.set(id, name)
  for (const a of actions) {
    const teammate = names.has(a.teammateId)
      ? { id: a.teammateId, name: names.get(a.teammateId)! }
      : null
    if (a.dueAt >= from && a.dueAt < to)
      items.push({
        key: `action:${a.id}`,
        kind: 'action',
        at: a.dueAt.toISOString(),
        title: a.title,
        missionId: a.initiativeId,
        threadId: a.sessionId,
        teammate,
        actionId: a.id,
        status: a.status,
        draft: a.draft,
      })
    if (a.status === 'awaiting_approval' && a.approveBy && a.approveBy >= from && a.approveBy < to)
      items.push({
        key: `approval:${a.id}`,
        kind: 'approval',
        at: a.approveBy.toISOString(),
        title: a.title,
        missionId: a.initiativeId,
        threadId: a.sessionId,
        teammate,
        actionId: a.id,
        status: a.status,
        draft: a.draft,
        ...(a.ticketId ? { ticketId: a.ticketId } : {}),
      })
  }
  return items.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key))
}

async function teammateNames(db: ScopedDb, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))]
  const rows = wanted.length
    ? await db.teammate.findMany({
        where: { id: { in: wanted } },
        select: { id: true, name: true },
      })
    : []
  return new Map(rows.map((t) => [t.id, t.name]))
}

/** A mission's number: a goal's measurements in one of its threads, else its declared values. */
async function numbersOf(db: ScopedDb, missions: Linked[], now: Date) {
  const since = new Date(now.getTime() - SERIES_DAYS * DAY)
  const ids = missions.map((m) => m.id)
  const threadIds = missions.flatMap((m) => m.sessions.map((s) => s.id))
  const [goals, values] = await Promise.all([
    threadIds.length
      ? db.goal.findMany({
          where: {
            sessionId: { in: threadIds },
            status: { in: ['active', 'paused', 'achieved', 'ended'] },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            sessionId: true,
            contract: true,
            measurements: {
              where: { status: 'ok', value: { not: null }, at: { gte: since } },
              orderBy: { at: 'asc' },
              select: { at: true, value: true },
            },
          },
        })
      : [],
    ids.length
      ? db.initiativeValue.findMany({
          where: { initiativeId: { in: ids }, at: { gte: since } },
          orderBy: { at: 'asc' },
          select: { initiativeId: true, value: true, at: true },
        })
      : [],
  ])
  const result = new Map<string, MissionNumber | null>()
  for (const m of missions) {
    const threads = new Set(m.sessions.map((s) => s.id))
    const goal = goals.find((g) => threads.has(g.sessionId) && g.measurements.length)
    if (goal) {
      const contract = goal.contract as { outcome?: string; target?: { value?: number } }
      result.set(m.id, {
        label: m.metricLabel ?? contract.outcome ?? 'Goal',
        unit: m.metricUnit,
        target: m.metricTarget ?? contract.target?.value ?? null,
        source: 'goal',
        series: goal.measurements.map((x) => ({ at: x.at.toISOString(), value: x.value! })),
      })
      continue
    }
    if (!m.metricLabel) {
      result.set(m.id, null)
      continue
    }
    result.set(m.id, {
      label: m.metricLabel,
      unit: m.metricUnit,
      target: m.metricTarget,
      source: 'declared',
      series: values
        .filter((v) => v.initiativeId === m.id)
        .map((v) => ({ at: v.at.toISOString(), value: v.value })),
    })
  }
  return result
}

/** What of a mission waits on the member: the Board's Needs you, and drafts to approve. */
async function needsOf(
  db: ScopedDb,
  scope: WorkspaceScope,
  missions: Linked[],
  now: Date,
): Promise<Map<string, MissionNeed[]>> {
  const result = new Map<string, MissionNeed[]>(missions.map((m) => [m.id, []]))
  if (!missions.length) return result
  const [view, awaiting] = await Promise.all([
    board(db, scope, now),
    db.initiativeAction.findMany({
      where: { initiativeId: { in: missions.map((m) => m.id) }, status: 'awaiting_approval' },
      orderBy: { approveBy: 'asc' },
      select: {
        id: true,
        initiativeId: true,
        sessionId: true,
        title: true,
        approveBy: true,
        ticketId: true,
        draft: true,
      },
    }),
  ])
  const missionOfThread = new Map(
    missions.flatMap((m) => m.sessions.map((s) => [s.id, m.id] as const)),
  )
  const missionOfRoutine = new Map(
    missions.flatMap((m) => m.routines.map((r) => [r.id, m.id] as const)),
  )
  // A thread whose only open tickets are drafts to approve: those say it, not a "ticket" card.
  const approvalTickets = new Set(awaiting.flatMap((a) => (a.ticketId ? [a.ticketId] : [])))
  const otherTickets = await db.ticket.groupBy({
    by: ['sessionId'],
    where: {
      sessionId: { in: [...missionOfThread.keys()] },
      status: 'open',
      ...(approvalTickets.size ? { id: { notIn: [...approvalTickets] } } : {}),
    },
    _count: true,
  })
  const withOther = new Set(otherTickets.map((t) => t.sessionId))
  for (const a of awaiting)
    result.get(a.initiativeId)?.push({
      threadId: a.sessionId,
      title: a.title,
      reason: 'approval',
      ...(a.ticketId ? { ticketId: a.ticketId } : {}),
      draft: a.draft,
      at: iso(a.approveBy),
    })
  for (const card of view.cards) {
    if (card.column !== 'needs_you') continue
    const missionId =
      card.kind === 'routine'
        ? missionOfRoutine.get(card.key.slice('routine:'.length))
        : card.threads.map((t) => missionOfThread.get(t.id)).find(Boolean)
    if (!missionId) continue
    const threadId = card.threads[0]?.id ?? null
    if (card.reason === 'ticket' && threadId && !withOther.has(threadId)) continue
    result.get(missionId)?.push({
      threadId,
      title: card.note ? `${card.title}: ${card.note}` : card.title,
      reason: card.reason ?? 'waiting',
    })
  }
  return result
}

/** GET /missions: one row per mission. */
export async function listMissions(
  db: ScopedDb,
  scope: WorkspaceScope,
  now = new Date(),
): Promise<MissionRow[]> {
  const missions = await missionsWithLinks(db)
  if (!missions.length) return []
  const ids = missions.map((m) => m.id)
  const [agenda, numbers, needs, outputs] = await Promise.all([
    agendaOf(db, missions, now, new Date(now.getTime() + 31 * DAY)),
    numbersOf(db, missions, now),
    needsOf(db, scope, missions, now),
    db.initiativeOutput.findMany({
      where: { initiativeId: { in: ids } },
      orderBy: { at: 'desc' },
      take: 200,
    }),
  ])
  const names = await teammateNames(
    db,
    outputs.map((o) => o.teammateId),
  )
  const routineIds = missions.flatMap((m) => m.routines.map((r) => r.id))
  const runs = routineIds.length
    ? await db.session.findMany({
        where: { scheduleId: { in: routineIds }, NOT: { report: { equals: Prisma.DbNull } } },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: { id: true, scheduleId: true, updatedAt: true, report: true },
      })
    : []
  return missions.map((m) => {
    const mine = outputs.filter((o) => o.initiativeId === m.id).slice(0, OUTPUTS_SHOWN)
    const routineSet = new Set(m.routines.map((r) => r.id))
    const lastRun = runs.find(
      (r) =>
        r.scheduleId && routineSet.has(r.scheduleId) && reportOf(r.report)?.status !== 'nothing',
    )
    const shown = mine.map((o) => outputView(o, names))
    return {
      id: m.id,
      title: m.title,
      objective: m.objective,
      teammate: m.teammate,
      metric: m.metricLabel
        ? { label: m.metricLabel, unit: m.metricUnit, target: m.metricTarget }
        : null,
      projectId: m.projectId,
      threads: m.sessions
        .filter((s) => !s.archivedAt)
        .map((s) => ({ id: s.id, title: s.title, status: s.status })),
      routines: m.routines.map((r) => ({
        id: r.id,
        title: r.title,
        nextRunAt: iso(r.nextRunAt),
        pausedAt: iso(r.pausedAt),
      })),
      number: numbers.get(m.id) ?? null,
      // What comes next: not an action that will not go (declined, expired) or already went.
      next:
        agenda.find(
          (i) =>
            i.missionId === m.id &&
            i.kind !== 'approval' &&
            (!i.status || i.status === 'planned' || i.status === 'awaiting_approval'),
        ) ?? null,
      needs: needs.get(m.id) ?? [],
      last: shown[0]
        ? { kind: 'output' as const, output: shown[0] }
        : lastRun
          ? {
              kind: 'run' as const,
              threadId: lastRun.id,
              at: lastRun.updatedAt.toISOString(),
              summary: reportOf(lastRun.report)?.summary ?? null,
            }
          : null,
      outputs: shown,
      archivedAt: iso(m.archivedAt),
    }
  })
}

/** GET /missions/week: the agenda across missions, from `from` for WEEK_DAYS days. */
export async function missionWeek(db: ScopedDb, from: Date): Promise<MissionWeek> {
  const to = new Date(from.getTime() + WEEK_DAYS * DAY)
  const missions = await missionsWithLinks(db)
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    items: await agendaOf(db, missions, from, to),
    missions: missions.map((m) => ({ id: m.id, title: m.title })),
  }
}

// ---- Made and changed from the Missions page ----

type LiveTx = Pick<ScopedDb, 'session' | 'schedule' | 'initiativeAction' | 'ticket'>

/**
 * Threads moving to a mission (or out of any): their live work follows them. Routines reporting to
 * them take the new mission; actions not run yet move with them, or, out of any mission, are
 * cancelled with their approval tickets. What went out stays where it was recorded.
 */
async function moveThreads(tx: LiveTx, threadIds: string[], to: string | null) {
  if (!threadIds.length) return { schedules: [] as string[] }
  const schedules = await tx.schedule.findMany({
    where: { parentSessionId: { in: threadIds } },
    select: { id: true },
  })
  if (schedules.length)
    await tx.schedule.updateMany({
      where: { id: { in: schedules.map((r) => r.id) } },
      data: { initiativeId: to },
    })
  const live = { sessionId: { in: threadIds }, status: { in: ['planned', 'awaiting_approval'] } }
  if (to) await tx.initiativeAction.updateMany({ where: live as never, data: { initiativeId: to } })
  else await cancelLive(tx, live)
  await tx.session.updateMany({ where: { id: { in: threadIds } }, data: { initiativeId: to } })
  return { schedules: schedules.map((r) => r.id) }
}

/** Actions not run yet, cancelled, and their approval tickets closed. */
async function cancelLive(tx: LiveTx, where: object) {
  const actions = await tx.initiativeAction.findMany({
    where: where as never,
    select: { id: true, ticketId: true },
  })
  if (!actions.length) return
  await tx.initiativeAction.updateMany({
    where: {
      id: { in: actions.map((a) => a.id) },
      status: { in: ['planned', 'awaiting_approval'] },
    },
    data: { status: 'cancelled' },
  })
  const tickets = actions.flatMap((a) => (a.ticketId ? [a.ticketId] : []))
  if (tickets.length)
    await tx.ticket.updateMany({
      where: { id: { in: tickets }, status: 'open' },
      data: { status: 'resolved', resolvedAt: new Date() },
    })
}

/**
 * A mission archived, its work over: its plan is cancelled and its routines paused, so nothing goes
 * on out of sight of the Missions page. Unarchiving brings neither back.
 */
async function retireMission(tx: LiveTx, missionId: string) {
  await cancelLive(tx, {
    initiativeId: missionId,
    status: { in: ['planned', 'awaiting_approval'] },
  })
  const threads = await tx.session.findMany({
    where: { initiativeId: missionId, parentId: null },
    select: { id: true },
  })
  const schedules = await tx.schedule.findMany({
    where: {
      pausedAt: null,
      OR: [
        { initiativeId: missionId },
        ...(threads.length ? [{ parentSessionId: { in: threads.map((t) => t.id) } }] : []),
      ],
    },
    select: { id: true },
  })
  if (schedules.length)
    await tx.schedule.updateMany({
      where: { id: { in: schedules.map((r) => r.id) } },
      data: { pausedAt: new Date(), nextRunAt: null },
    })
  return { schedules: schedules.map((r) => r.id) }
}

const schedulesChanged = (scope: Scope, ids: string[]) => {
  for (const id of ids) void hubs.get(scope.workspaceId).broadcast(scheduleUpdated(id))
}

/**
 * A member who changes a mission speaks in its threads: its words reach their teammates' next turns
 * (their spec's mission), so they count as asking there (thread-spec.ts askedBy), and a member's own
 * Apps no longer answer another's word.
 */
async function noteMember(db: ScopedDb, scope: WorkspaceScope, threadIds: string[]) {
  for (const id of new Set(threadIds)) await noteAsker(db, id, scope.memberId)
}

/**
 * The threads a member gives a mission: at the top (a sub-thread or a routine's run belongs to its
 * parent's or its routine's), and ones they may write in, or any for an admin, as for closing one.
 */
async function threadsToGive(db: ScopedDb, scope: WorkspaceScope, ids: string[]) {
  const wanted = [...new Set(ids)]
  if (!wanted.length) return []
  const rows = await db.session.findMany({
    where: { id: { in: wanted } },
    select: {
      id: true,
      parentId: true,
      startedByMemberId: true,
      othersMayPrompt: true,
      computer: { select: { kind: true } },
    },
  })
  const admin = scope.role === 'owner' || scope.role === 'admin'
  for (const id of wanted) {
    const row = rows.find((r) => r.id === id)
    if (!row) throw new HTTPException(404, { message: 'One of these threads is gone' })
    if (row.parentId)
      throw new HTTPException(400, {
        message: 'A sub-thread belongs to its parent’s mission: give the parent thread instead',
      })
    if (!admin && !mayWrite(row, scope))
      throw new HTTPException(403, {
        message: 'You can give a mission only threads you may write in',
      })
  }
  return wanted
}

async function ownerOf(db: ScopedDb, teammateId: string) {
  const teammate = await db.teammate.findFirst({
    where: { id: teammateId, archivedAt: null },
    select: { id: true },
  })
  if (!teammate) throw new HTTPException(400, { message: 'No such teammate' })
  return teammate.id
}

/** POST /missions: a mission, with the threads it gathers (each leaves any mission it was in). */
export async function createMission(db: ScopedDb, scope: WorkspaceScope, input: CreateMission) {
  const teammateId = await ownerOf(db, input.teammateId)
  const threads = await threadsToGive(db, scope, input.threadIds)
  const projectId = input.projectId
    ? ((await db.project.findFirst({ where: { id: input.projectId }, select: { id: true } }))?.id ??
      null)
    : null
  const mission = await db.$transaction(async (tx) => {
    const row = await tx.initiative.create({
      data: {
        teammateId,
        projectId,
        title: input.title,
        objective: input.objective,
        ...metricData(input.metric ?? null),
        createdByMemberId: scope.memberId,
      } as never,
    })
    const moved = await moveThreads(tx, threads, row.id)
    return { ...row, schedules: moved.schedules }
  })
  await noteMember(db, scope, threads)
  schedulesChanged(scope, mission.schedules)
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: 'mission.created',
    target: { type: 'mission', id: mission.id },
    data: { threads: threads.length },
  })
  for (const id of threads) changed(scope, id)
  return { id: mission.id }
}

/** PATCH /missions/:id: its words, owner, number, threads (the whole set), or archived. */
export async function updateMission(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  input: UpdateMission,
) {
  const mission = await db.initiative.findFirst({ where: { id }, select: { id: true } })
  if (!mission) throw new HTTPException(404, { message: 'No such mission' })
  const teammateId = input.teammateId ? await ownerOf(db, input.teammateId) : undefined
  const current = input.threadIds
    ? await db.session.findMany({
        where: { initiativeId: id, parentId: null },
        select: { id: true },
      })
    : []
  const kept = new Set(current.map((t) => t.id))
  // Only the threads added are checked: one already there may stay, whoever reads it.
  const added = input.threadIds
    ? await threadsToGive(
        db,
        scope,
        input.threadIds.filter((t) => !kept.has(t)),
      )
    : []
  const removed = input.threadIds
    ? current.map((t) => t.id).filter((t) => !input.threadIds!.includes(t))
    : []
  const schedules = await db.$transaction(async (tx) => {
    await tx.initiative.update({
      where: { id },
      data: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.objective ? { objective: input.objective } : {}),
        ...(teammateId ? { teammateId } : {}),
        ...(input.metric !== undefined ? metricData(input.metric) : {}),
        ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
      },
    })
    const touched = [
      ...(await moveThreads(tx, added, id)).schedules,
      ...(await moveThreads(tx, removed, null)).schedules,
    ]
    if (input.archived) touched.push(...(await retireMission(tx, id)).schedules)
    return touched
  })
  // Its words, owner or number reach its threads' teammates: the member speaks in each of them.
  const speaks =
    !!input.title ||
    !!input.objective ||
    !!teammateId ||
    input.metric !== undefined ||
    input.archived !== undefined
  const threadsNow = speaks
    ? (
        await db.session.findMany({
          where: { initiativeId: id, parentId: null },
          select: { id: true },
        })
      ).map((t) => t.id)
    : []
  await noteMember(db, scope, [...added, ...threadsNow])
  schedulesChanged(scope, [...new Set(schedules)])
  await audit({
    ...scope,
    actor: { type: 'member', id: scope.memberId },
    action: input.archived ? 'mission.archived' : 'mission.updated',
    target: { type: 'mission', id },
    data: { added: added.length, removed: removed.length },
  })
  for (const t of [...added, ...removed]) changed(scope, t)
  return { id }
}
