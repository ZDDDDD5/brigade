import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Snooze (src/later.ts, Later in the code) against a real database: the local one of apps/api/.env, in an
// organization of its own that it removes at the end. Without a database to reach, it is skipped.
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
    await client.query('select 1 from "ThreadLater" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const { bringBackFromLater, laterKey, latersIn, latersOf, setLater, snoozeUntil, wakeDueSnoozes } =
  await import('../src/later.js')
const { setThreadArchived } = await import('../src/thread-archive.js')
const { homeFor } = await import('../src/home.js')
const { needsAttention } = await import('../src/pull-requests.js')

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-later-${id}`,
  users: [`user-later-${id}`, `user-later-b-${id}`],
  members: [`mem-later-${id}`, `mem-later-b-${id}`],
}
let scope: { organizationId: string; workspaceId: string }
let teammateId: string
let computerId: string

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Later test', slug: ids.organization },
  })
  for (const [i, userId] of ids.users.entries()) {
    await prisma.user.create({
      data: { id: userId, name: `Member ${i}`, email: `${userId}@example.com` },
    })
    await prisma.member.create({
      data: { id: ids.members[i]!, organizationId: ids.organization, userId, role: 'owner' },
    })
  }
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Later test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  teammateId = (await prisma.teammate.create({ data: { ...scope, name: 'Riley' } })).id
  computerId = (
    await prisma.computer.create({
      data: { ...scope, kind: 'member_machine', memberId: ids.members[0], name: 'Laptop' },
    })
  ).id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } })
  await prisma.$disconnect()
})

let titles = 0
const thread = (parentId?: string) =>
  prisma.session.create({
    data: {
      ...scope,
      teammateId,
      startedByMemberId: ids.members[0]!,
      computerId,
      title: `Thread ${++titles}`,
      status: 'idle',
      origin: parentId ? 'child' : 'member',
      ...(parentId ? { parentId, parentTeammateId: teammateId } : {}),
    },
  })
/** A week on: as long as a test needs it snoozed. */
const week = () => new Date(Date.now() + 7 * 86_400_000)
const as = (member: number) => ({ ...scope, memberId: ids.members[member]! })
const later = (member: number) => latersOf(scoped(scope), ids.members[member]!)
/** The scoped write hooks run after the write, not awaited: let them finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

test('snoozing a thread is each member’s own, and Wake now undoes it', { skip }, async () => {
  const t = await thread()
  await setLater(scoped(scope), as(0), t, week())
  assert.ok((await later(0)).has(t.id))
  assert.equal((await later(1)).has(t.id), false)
  assert.ok((await latersIn(scope.workspaceId)).has(laterKey(ids.members[0]!, t.id)))
  await setLater(scoped(scope), as(0), t, null)
  assert.equal((await later(0)).has(t.id), false)
})

test(
  'a ticket opened in it, or in one of its children, brings it back for everyone',
  { skip },
  async () => {
    const t = await thread()
    const child = await thread(t.id)
    await setLater(scoped(scope), as(0), t, week())
    await setLater(scoped(scope), as(1), t, week())
    await scoped(scope).ticket.create({
      data: { ...scope, sessionId: child.id, type: 'question', title: 'Which plan?' },
    } as never)
    await settle()
    assert.equal((await later(0)).has(t.id), false)
    assert.equal((await later(1)).has(t.id), false)
  },
)

test('a pull request opened in it brings it back', { skip }, async () => {
  const t = await thread()
  await setLater(scoped(scope), as(0), t, week())
  await scoped(scope).pullRequest.create({
    data: {
      ...scope,
      sessionId: t.id,
      repository: 'acme/web',
      number: titles,
      title: 'Fix',
      headRef: 'fix',
      baseRef: 'main',
    },
  } as never)
  await settle()
  assert.equal((await later(0)).has(t.id), false)
})

test(
  'a message or a turn brings it back (what the hub calls on its events)',
  { skip },
  async () => {
    const t = await thread()
    await setLater(scoped(scope), as(0), t, week())
    await bringBackFromLater(scope, t.id)
    assert.equal((await later(0)).has(t.id), false)
  },
)

test('archiving it is no longer for later', { skip }, async () => {
  const t = await thread()
  await setLater(scoped(scope), as(0), t, week())
  await setThreadArchived(scope, t.id, true)
  assert.equal((await later(0)).has(t.id), false)
})

test('Home’s threads leave out those put away for later', { skip }, async () => {
  const t = await thread()
  const listed = async () =>
    JSON.stringify(await homeFor(scoped(scope), ids.members[0]!)).includes(t.id)
  await prisma.sessionEvent.create({
    data: {
      ...scope,
      sessionId: t.id,
      seq: 1,
      at: new Date(),
      type: 'turn.completed',
      data: { type: 'turn.completed' },
    },
  } as never)
  assert.ok(await listed())
  await setLater(scoped(scope), as(0), t, week())
  assert.equal(await listed(), false)
})

test(
  'pull requests waiting on a person leave out those of a thread put away, and its children',
  { skip },
  async () => {
    const t = await thread()
    const child = await thread(t.id)
    const other = await thread()
    const pr = (sessionId: string | null, n: number) =>
      prisma.pullRequest.create({
        data: {
          ...scope,
          sessionId,
          repository: 'acme/api',
          number: n,
          title: `PR ${n}`,
          headRef: `b${n}`,
          baseRef: 'main',
          mergeStatus: sessionId ? 'none' : 'stuck',
        },
      } as never)
    await pr(t.id, 101)
    await pr(child.id, 102)
    await pr(other.id, 103)
    await pr(null, 104)
    const numbers = async (putAway: string[]) =>
      (await needsAttention(scoped(scope), putAway))
        .filter((p) => p.repository === 'acme/api')
        .map((p) => p.number)
        .sort()
    assert.deepEqual(await numbers([]), [101, 102, 103, 104])
    assert.deepEqual(await numbers([t.id]), [103, 104])
  },
)

test(
  'for a member who may not merge, only those of the threads they started',
  { skip },
  async () => {
    const mine = await thread()
    const theirs = await prisma.session.update({
      where: { id: (await thread()).id },
      data: { startedByMemberId: ids.members[1]! },
    })
    const pr = (sessionId: string | null, n: number) =>
      prisma.pullRequest.create({
        data: {
          ...scope,
          sessionId,
          repository: 'acme/members',
          number: n,
          title: `PR ${n}`,
          headRef: `m${n}`,
          baseRef: 'main',
          mergeStatus: sessionId ? 'none' : 'stuck',
        },
      } as never)
    await pr(mine.id, 201)
    await pr(theirs.id, 202)
    await pr(null, 203)
    const numbers = async (startedBy?: string) =>
      (await needsAttention(scoped(scope), [], { startedBy }))
        .filter((p) => p.repository === 'acme/members')
        .map((p) => p.number)
        .sort()
    assert.deepEqual(await numbers(), [201, 202, 203])
    assert.deepEqual(await numbers(ids.members[1]!), [202])
  },
)

test(
  'a snooze comes back at its time, unread, and a second run of the job changes nothing',
  { skip },
  async () => {
    const t = await thread()
    await prisma.sessionEvent.create({
      data: {
        ...scope,
        sessionId: t.id,
        seq: 1,
        at: new Date(Date.now() - 60_000),
        type: 'turn.completed',
        data: { type: 'turn.completed' },
      },
    } as never)
    await prisma.threadRead.create({
      data: { ...scope, memberId: ids.members[0]!, sessionId: t.id },
    })
    const soon = new Date(Date.now() + 60_000)
    await setLater(scoped(scope), as(0), t, soon)
    await setLater(scoped(scope), as(1), t, week())
    assert.ok((await later(0)).has(t.id))
    assert.equal((await later(0)).get(t.id)?.until.getTime(), soon.getTime())
    // Not yet due: nothing moves.
    await wakeDueSnoozes(scope.workspaceId)
    assert.ok((await later(0)).has(t.id))
    // Past its time it is back already, before the job clears it.
    const past = new Date(soon.getTime() + 1_000)
    assert.equal((await latersOf(scoped(scope), ids.members[0]!, past)).has(t.id), false)
    assert.ok(await wakeDueSnoozes(scope.workspaceId, past))
    const rows = await prisma.threadLater.findMany({ where: { sessionId: t.id } })
    assert.deepEqual(
      rows.map((r) => r.memberId),
      [ids.members[1]],
      'the other member’s snooze stays',
    )
    const read = await prisma.threadRead.findMany({ where: { sessionId: t.id } })
    assert.equal(read.length, 0, 'unread for the member it came back to')
    assert.equal(await wakeDueSnoozes(scope.workspaceId, past), 0)
  },
)

test('the times a snooze takes', () => {
  const now = new Date('2026-11-15T12:00:00Z')
  assert.equal(snoozeUntil(undefined, now)?.toISOString(), '2026-11-22T12:00:00.000Z')
  assert.equal(snoozeUntil('2026-11-15T13:00:00Z', now)?.toISOString(), '2026-11-15T13:00:00.000Z')
  assert.equal(snoozeUntil('2026-12-17T12:00:00Z', now)?.toISOString(), '2026-12-17T12:00:00.000Z')
  assert.equal(snoozeUntil('2026-11-15T11:59:00Z', now), null, 'in the past')
  assert.equal(snoozeUntil('2026-12-18T12:00:01Z', now), null, 'more than 32 days')
  assert.equal(snoozeUntil('soon', now), null)
  assert.equal(snoozeUntil(3600, now), null)
})
