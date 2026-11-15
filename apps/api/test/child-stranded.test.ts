import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A child's report its turn's end never sent on (src/children.ts, settleStrandedChildren): the
// API restarted as it ran. Against a real database: The local one of apps/api/.env, in an organization of its
// own that it removes at the end. Without a database to reach, it is skipped.
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
// The files' bytes, in a folder of the test's own.
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'child-stranded-'))

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "report" from "Session" limit 1')
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
  dueChildren,
  handleChildCall,
  noteChildEvents,
  settleStrandedChildren,
  STRANDED_AFTER_MS,
  STRANDED_WITHIN_MS,
} = await import('../src/children.js')

type Row = Awaited<ReturnType<typeof prisma.session.create>>
const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-stranded-${id}`,
  user: `user-stranded-${id}`,
  member: `mem-stranded-${id}`,
}
let scope: { organizationId: string; workspaceId: string }
let riley: { id: string; name: string }
let cody: { id: string; name: string }
let computerId: string

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Stranded test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Stranded test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  for (const name of ['Riley', 'Cody']) {
    const row = await prisma.teammate.create({ data: { ...scope, name } })
    if (name === 'Riley') riley = { id: row.id, name }
    else cody = { id: row.id, name }
  }
  // Offline: a parent's wake-up is stored and waits, as it would.
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
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

let titles = 0
/** Riley's thread, and a child it handed to Cody, waited for or not. */
async function family({ awaited = false } = {}) {
  const thread = (data: object): Promise<Row> =>
    prisma.session.create({
      data: {
        ...scope,
        startedByMemberId: ids.member,
        computerId,
        title: `Thread ${++titles}`,
        status: 'idle',
        ...data,
      } as never,
    })
  const parent = await thread({ teammateId: riley.id, origin: 'member' })
  const child = await thread({
    teammateId: cody.id,
    origin: 'child',
    parentId: parent.id,
    parentTeammateId: riley.id,
    awaited,
    ...(awaited ? { awaitUntil: new Date(Date.now() + 24 * 60 * 60_000) } : {}),
  })
  return { parent, child }
}

let seq = 0
/** An event its runner sent, stored as src/hub/runner-messages.ts does: the thread's lastSeq moves on. */
async function event(session: Row, type: string, data: object, at = new Date()) {
  const row = await prisma.sessionEvent.create({
    data: {
      ...scope,
      sessionId: session.id,
      seq: ++seq,
      type,
      data: { type, at: at.toISOString(), ...data },
      at,
    },
  })
  await prisma.session.update({ where: { id: session.id }, data: { lastSeq: row.seq } })
  return row
}

/**
 * Its turn as its runner stores it, minus what the end of a turn does (noteChildEvents): the
 * restart cut that short. Then nothing changes it for `quietFor`.
 */
async function strandedTurn(child: Row, text: string, quietFor = STRANDED_AFTER_MS + 60_000) {
  const ended = new Date(Date.now() - quietFor)
  await event(child, 'message.done', { text }, ended)
  await event(child, 'turn.completed', {}, ended)
  await quiet(child, quietFor)
}

/** Nothing changed it for that long. */
const quiet = (child: Row, ms: number) =>
  prisma.$executeRaw`UPDATE "Session" SET "updatedAt" = ${new Date(Date.now() - ms)} WHERE id = ${child.id}`

/** What it reported in its turn (the report tool), with nothing settling the turn's end. */
const reportInTurn = (child: Row, summary: string) =>
  handleChildCall(scoped(scope), scope, child, cody, { name: 'report', status: 'report', summary })

const notes = async (session: { id: string }) =>
  (
    await prisma.wakeup.findMany({
      where: { sessionId: session.id, kind: 'report' },
      orderBy: { createdAt: 'asc' },
      select: { note: true },
    })
  ).map((w) => w.note)

const delivered = async (child: Row) =>
  (
    await prisma.session.findUniqueOrThrow({
      where: { id: child.id },
      select: { reportDeliveredAt: true },
    })
  ).reportDeliveredAt

const sweep = () => settleStrandedChildren(scope.workspaceId)

test(
  'a report its turn reported, cut short, reaches the parent that waits for it',
  { skip },
  async () => {
    const { parent, child } = await family({ awaited: true })
    await reportInTurn(child, 'Approved at 6a07490.')
    await strandedTurn(child, 'Approved.')
    assert.deepEqual(await notes(parent), [])
    // Due: the minute's tick runs for its workspace.
    assert.ok((await dueChildren()).includes(scope.workspaceId))

    await sweep()
    const [note, ...more] = await notes(parent)
    assert.equal(more.length, 0)
    assert.match(note!, /Approved at 6a07490\./)
    assert.ok(await delivered(child))
    // Once: the next tick finds nothing.
    await sweep()
    assert.equal((await notes(parent)).length, 1)
  },
)

test('a turn that ended without a report sends its last message', { skip }, async () => {
  const { parent, child } = await family()
  await event(child, 'message.user', { text: 'Look at #860 again.' })
  await strandedTurn(child, 'Nothing blocks it.')
  await sweep()
  const [note] = await notes(parent)
  assert.match(note!, /Nothing blocks it\./)
  assert.ok(await delivered(child))
})

test(
  'a report older than the message after it is not sent: that turn answers',
  { skip },
  async () => {
    const { parent, child } = await family()
    await reportInTurn(child, 'First look.')
    // Asked again, and the message's own settling (clearing that report) was cut short too.
    await new Promise((r) => setTimeout(r, 5))
    await event(child, 'message.user', { text: 'Look again.' })
    await strandedTurn(child, 'Second look.')
    await sweep()
    const [note, ...more] = await notes(parent)
    assert.equal(more.length, 0)
    assert.match(note!, /Second look\./)
    assert.doesNotMatch(note!, /First look\./)
  },
)

test('a child still settling, or still at work, is left alone', { skip }, async () => {
  // Its turn just ended: the end of it may still be under way.
  const fresh = await family()
  await strandedTurn(fresh.child, 'Just done.', 10_000)
  // A message came after its turn ended: the next turn reports.
  const asked = await family()
  await strandedTurn(asked.child, 'Done before.')
  await event(asked.child, 'message.user', { text: 'One more thing.' })
  await quiet(asked.child, STRANDED_AFTER_MS + 60_000)
  // At work.
  const working = await family()
  await strandedTurn(working.child, 'Half.')
  await prisma.$executeRaw`UPDATE "Session" SET status = 'running', "updatedAt" = ${new Date(Date.now() - 10 * 60_000)} WHERE id = ${working.child.id}`
  // Its turn ended over an hour ago with no report: past what is looked at.
  const old = await family()
  await strandedTurn(old.child, 'Long ago.', STRANDED_WITHIN_MS + 60_000)

  await sweep()
  for (const { parent, child } of [fresh, asked, working, old]) {
    assert.deepEqual(await notes(parent), [])
    assert.equal(await delivered(child), null)
  }
})

test('a report waits for the other children its parent still waits for', { skip }, async () => {
  const { parent, child } = await family({ awaited: true })
  const sibling = await prisma.session.create({
    data: {
      ...scope,
      startedByMemberId: ids.member,
      computerId,
      title: `Thread ${++titles}`,
      status: 'running',
      teammateId: cody.id,
      origin: 'child',
      parentId: parent.id,
      parentTeammateId: riley.id,
      awaited: true,
      awaitUntil: new Date(Date.now() + 24 * 60 * 60_000),
    } as never,
  })
  await reportInTurn(child, 'Mine is done.')
  await strandedTurn(child, 'Done.')
  await sweep()
  assert.deepEqual(await notes(parent), [])
  assert.equal(await delivered(child), null)
  // The other one reports, and its own turn's end is cut short too: both go, in one note.
  await reportInTurn(sibling as Row, 'Mine too.')
  await prisma.$executeRaw`UPDATE "Session" SET status = 'idle' WHERE id = ${sibling.id}`
  await strandedTurn(sibling as Row, 'Done too.')
  await sweep()
  const [note, ...more] = await notes(parent)
  assert.equal(more.length, 0)
  assert.match(note!, /Mine is done\./)
  assert.match(note!, /Mine too\./)
})

test('a turn a wake-up holds stays held, and tells nobody', { skip }, async () => {
  const { parent, child } = await family()
  await prisma.wakeup.create({
    data: {
      ...scope,
      sessionId: child.id,
      teammateId: cody.id,
      note: 'Check the deploy.',
      wakeAt: new Date(Date.now() + 60 * 60_000),
    },
  })
  await strandedTurn(child, 'Waiting for the deploy.')
  await sweep()
  assert.deepEqual(await notes(parent), [])
  const row = await prisma.session.findUniqueOrThrow({
    where: { id: child.id },
    select: { report: true, reportDeliveredAt: true },
  })
  assert.equal(row.report, null)
  assert.equal(row.reportDeliveredAt, null)
})

test('a conversation with a person, cut short, waits for them to go quiet', { skip }, async () => {
  const { parent, child } = await family()
  await event(child, 'message.user', { text: 'What do you think?', memberId: ids.member })
  await strandedTurn(child, 'I think so.')
  await sweep()
  assert.deepEqual(await notes(parent), [])
  const row = await prisma.session.findUniqueOrThrow({
    where: { id: child.id },
    select: { reportDueAt: true },
  })
  assert.ok(row.reportDueAt)
})

/**
 * Runs `sweep`, and `between` once, as soon as a read of the child's events that `when` picks has
 * answered: what comes in while the sweep plays its turn's end again.
 */
async function interleaved(
  when: (types: string[]) => boolean,
  between: () => Promise<void>,
  run: () => Promise<void>,
) {
  const delegate = prisma.sessionEvent
  const original = delegate.findFirst
  let came = false
  delegate.findFirst = (async (args: { where?: { type?: string | { in?: string[] } } }) => {
    const found = await original.call(delegate, args as never)
    const type = args?.where?.type
    const types = typeof type === 'string' ? [type] : (type?.in ?? [])
    if (!came && when(types)) {
      came = true
      await between()
    }
    return found
  }) as never
  try {
    await run()
  } finally {
    delegate.findFirst = original
  }
  assert.ok(came, 'the next turn came in during the sweep')
}

/** Its next turn begins: the message its runner sent stored, the thread at work again. */
async function nextTurn(child: Row, settle: boolean) {
  const at = new Date()
  await event(child, 'message.user', { text: 'Look again.' }, at)
  await prisma.session.update({ where: { id: child.id }, data: { status: 'running' } })
  if (settle)
    await noteChildEvents(child, [{ event: { type: 'message.user', at: at.toISOString() } }])
}

test(
  'a next turn that begins as its last message is read is not answered with it',
  { skip },
  async () => {
    const { parent, child } = await family()
    await strandedTurn(child, 'The old answer.')
    // As the sweep reads its last message to stand in for a report.
    await interleaved(
      (types) => types.includes('message.done'),
      () => nextTurn(child, true),
      sweep,
    )
    assert.deepEqual(await notes(parent), [])
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: child.id },
      select: { report: true, reportDeliveredAt: true },
    })
    assert.equal(row.report, null)
    assert.equal(row.reportDeliveredAt, null)
  },
)

for (const awaited of [true, false])
  test(
    `a next turn that begins before its report is claimed keeps it (${awaited ? 'awaited' : 'not awaited'})`,
    { skip },
    async () => {
      const { parent, child } = await family({ awaited })
      await reportInTurn(child, 'The old report.')
      await strandedTurn(child, 'Old.')
      // As the sweep reads its turn's end: the message is stored, its own settling not run yet.
      await interleaved(
        (types) => types.includes('turn.completed'),
        () => nextTurn(child, false),
        sweep,
      )
      assert.deepEqual(await notes(parent), [])
      assert.equal(await delivered(child), null)

      // That message settles, and the next turn reports: its report alone reaches the parent.
      const asked = await prisma.sessionEvent.findFirstOrThrow({
        where: { sessionId: child.id, type: 'message.user' },
        orderBy: { seq: 'desc' },
      })
      await noteChildEvents(child, [
        { event: { type: 'message.user', at: asked.at.toISOString() } },
      ])
      await reportInTurn(child, 'The new report.')
      await prisma.session.update({ where: { id: child.id }, data: { status: 'idle' } })
      await noteChildEvents(child, [
        { event: { type: 'turn.completed', at: new Date().toISOString() } },
      ])
      const [note, ...more] = await notes(parent)
      assert.equal(more.length, 0)
      assert.match(note!, /The new report\./)
      assert.doesNotMatch(note!, /The old report\./)
    },
  )
