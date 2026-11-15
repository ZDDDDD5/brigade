// Snooze (Later in the code and the database): a member puts a thread away until a time they
// pick, for themselves only, as they pin one. It leaves their sidebar's list (the filter's
// Snoozed shows it) and what waits on them: its tickets and pull requests leave their Home,
// sidebar, app badge and notifications. At its time it comes back, unread for them
// (wakeDueSnoozes, each minute). Like an archive, anything new there brings it back sooner: a
// message in it (a member's, a wake-up's, a child's report), or a ticket or pull request opened
// in it or one of its children.
import { SNOOZE_MAX_DAYS } from '@brigade/contracts'
import { onScopedWrite, prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hubs, threadUpdated } from './hub.js'
import { rootIdOf } from './thread-root.js'

const DAY = 24 * 60 * 60_000

/**
 * The threads this member snoozed: id, since when and until when. One past its time is back
 * already, before the minute's job clears it.
 */
export async function latersOf(db: ScopedDb, memberId: string, now = new Date()) {
  const rows = await db.threadLater.findMany({
    where: { memberId, until: { gt: now } },
    select: { sessionId: true, laterAt: true, until: true },
  })
  return new Map(rows.map((r) => [r.sessionId, { at: r.laterAt, until: r.until }] as const))
}

/** Who snoozed which thread in a workspace, as `memberId:sessionId`, for notifications. */
export async function latersIn(workspaceId: string, now = new Date()) {
  const rows = await prisma.threadLater.findMany({
    where: { workspaceId, until: { gt: now } },
    select: { memberId: true, sessionId: true },
  })
  return new Set(rows.map((r) => laterKey(r.memberId, r.sessionId)))
}

export const laterKey = (memberId: string, sessionId: string) => `${memberId}:${sessionId}`

/**
 * When a snooze ends: the time asked for, in the future and at most SNOOZE_MAX_DAYS away; a
 * week when none was asked (a dashboard older than Snooze). Null: not a time it takes.
 */
export function snoozeUntil(asked: unknown, now = new Date()): Date | null {
  if (asked === undefined || asked === null) return new Date(now.getTime() + 7 * DAY)
  if (typeof asked !== 'string') return null
  const until = new Date(asked)
  const ms = until.getTime() - now.getTime()
  if (Number.isNaN(ms) || ms <= 0 || ms > SNOOZE_MAX_DAYS * DAY) return null
  return until
}

/**
 * Snoozed for this member until `until`, or back in their list (null). Not a child: it shows
 * in its parent.
 */
export async function setLater(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  thread: { id: string; status: string },
  until: Date | null,
) {
  if (until)
    await db.threadLater.upsert({
      where: { memberId_sessionId: { memberId: scope.memberId, sessionId: thread.id } },
      create: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        memberId: scope.memberId,
        sessionId: thread.id,
        until,
      },
      update: { laterAt: new Date(), until },
    })
  else
    await db.threadLater.deleteMany({ where: { memberId: scope.memberId, sessionId: thread.id } })
  changed(scope, thread)
}

/** Something new in a thread, or in one of its sub-threads: back in everyone's list. */
export async function bringBackFromLater(scope: Scope, sessionId: string) {
  const db = scoped(scope)
  const rootId = await rootIdOf(db, sessionId)
  if (!rootId) return
  const root = await db.session.findFirst({
    where: { id: rootId },
    select: { id: true, status: true },
  })
  if (!root) return
  const { count } = await db.threadLater.deleteMany({ where: { sessionId: root.id } })
  if (count) changed(scope, root)
}

/** Workspaces with a snooze at its end. */
export async function dueSnoozes(now = new Date()) {
  const rows = await prisma.threadLater.findMany({
    where: { until: { lte: now } },
    distinct: ['workspaceId'],
    select: { workspaceId: true },
  })
  return rows.map((r) => r.workspaceId)
}

/**
 * Snoozes at their end, of one workspace or all: each thread back in its member's list, unread
 * for them so it shows it came back. Each row is claimed by its deletion, so a second run of
 * the job leaves it alone; one snoozed again meanwhile has a later time and stays.
 */
export async function wakeDueSnoozes(workspaceId?: string, now = new Date()) {
  const due = await prisma.threadLater.findMany({
    where: { until: { lte: now }, ...(workspaceId ? { workspaceId } : {}) },
    select: {
      organizationId: true,
      workspaceId: true,
      memberId: true,
      sessionId: true,
      until: true,
      session: { select: { status: true } },
    },
    orderBy: { until: 'asc' },
    take: 200,
  })
  for (const row of due) {
    const { count } = await prisma.threadLater.deleteMany({
      where: { memberId: row.memberId, sessionId: row.sessionId, until: row.until },
    })
    if (!count) continue
    await prisma.threadRead.deleteMany({
      where: { memberId: row.memberId, sessionId: row.sessionId },
    })
    changed(row, { id: row.sessionId, status: row.session.status })
  }
  return due.length
}

/**
 * Its row moves in the sidebar, and what waits on the member changes: the dashboards
 * read the list, tickets and pull requests again.
 */
function changed(scope: Pick<Scope, 'workspaceId'>, thread: { id: string; status: string }) {
  void hubs.get(scope.workspaceId).broadcast(threadUpdated(thread.id, thread.status))
  void hubs.get(scope.workspaceId).notifyList('tickets.updated')
  void hubs.get(scope.workspaceId).notifyList('pulls.updated')
}

onScopedWrite((model, scope, operation, result) => {
  if (operation !== 'create') return
  const row = result as { sessionId?: string | null; status?: string; state?: string }
  if (!row.sessionId) return
  if (
    (model === 'Ticket' && row.status === 'open') ||
    (model === 'PullRequest' && row.state === 'open')
  )
    void bringBackFromLater(scope, row.sessionId).catch((error) =>
      console.warn(`later: ${row.sessionId} not brought back: ${String(error)}`),
    )
})
