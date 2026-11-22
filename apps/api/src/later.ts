// Snooze (Later in the code and the database): a member puts a thread away until a time they
// pick, for themselves only, as they pin one. It leaves their sidebar's list (the filter's
// Snoozed shows it) and what waits on them: its tickets and pull requests leave their Home,
// sidebar, app badge and notifications. At its time it comes back, unread for them
// (wakeDueSnoozes, each minute), and its row stays a week (RETURNED_DAYS) with `returnedAt`:
// their sidebar lists it by that time, however old its last activity, so it shows on top of
// their threads rather than past the list's last 100. A row past its `until` counts as awake
// everywhere else. Like an archive, anything new there brings it back sooner: a
// message in it (a member's, a wake-up's, a child's report), or a ticket or pull request opened
// in it or one of its children.
import { SNOOZE_MAX_DAYS } from '@brigade/contracts'
import { onScopedWrite, prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { hubs, threadUpdated } from './hub.js'
import { rootIdOf } from './thread-root.js'

const DAY = 24 * 60 * 60_000
/** How long a snooze that came back keeps its place on top of its member's list. */
export const RETURNED_DAYS = 7

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

/** The threads that came back to this member lately from a snooze: id, and when. */
export async function returnsOf(db: ScopedDb, memberId: string, now = new Date()) {
  const rows = await db.threadLater.findMany({
    where: { memberId, returnedAt: { gte: new Date(now.getTime() - RETURNED_DAYS * DAY) } },
    select: { sessionId: true, returnedAt: true },
  })
  return new Map(rows.map((r) => [r.sessionId, r.returnedAt!] as const))
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
      update: { laterAt: new Date(), until, returnedAt: null },
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

/** Snoozes at their end not brought back yet, and those back past their week. */
const due = (now: Date) => ({
  OR: [
    { until: { lte: now }, returnedAt: null },
    { returnedAt: { lt: new Date(now.getTime() - RETURNED_DAYS * DAY) } },
  ],
})

/** Workspaces with a snooze at its end, or one back past its week. */
export async function dueSnoozes(now = new Date()) {
  const rows = await prisma.threadLater.findMany({
    where: due(now),
    distinct: ['workspaceId'],
    select: { workspaceId: true },
  })
  return rows.map((r) => r.workspaceId)
}

/**
 * Snoozes at their end, of one workspace or all: each thread back on top of its member's list,
 * unread for them so it shows it came back. Each row is claimed by setting its `returnedAt`,
 * so a second run of the job leaves it alone; one snoozed again meanwhile has a later time and
 * stays asleep. Rows back for over RETURNED_DAYS go.
 */
export async function wakeDueSnoozes(workspaceId?: string, now = new Date()) {
  const where = workspaceId ? { workspaceId } : {}
  await prisma.threadLater.deleteMany({
    where: { ...where, returnedAt: { lt: new Date(now.getTime() - RETURNED_DAYS * DAY) } },
  })
  const waking = await prisma.threadLater.findMany({
    where: { ...where, until: { lte: now }, returnedAt: null },
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
  for (const row of waking) {
    const { count } = await prisma.threadLater.updateMany({
      where: {
        memberId: row.memberId,
        sessionId: row.sessionId,
        until: row.until,
        returnedAt: null,
      },
      data: { returnedAt: now },
    })
    if (!count) continue
    await prisma.threadRead.deleteMany({
      where: { memberId: row.memberId, sessionId: row.sessionId },
    })
    changed(row, { id: row.sessionId, status: row.session.status })
  }
  return waking.length
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
