import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { Hono } from 'hono'
import pg from 'pg'
import { sessionStub } from './session-stub.js'

// Give feedback (src/routes/feedback.ts): files go to one feedback only, whatever races it, and
// one member can't flood the team. Against a real database: the local one of apps/api/.env, in
// an organization of its own that it removes at the end. Without a database to reach, skipped.
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
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'feedback-'))

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "id" from "Feedback" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma } = await import('../src/db.js')
const { auth } = await import('../src/auth.js')
const { feedback, FEEDBACK_LIMITS } = await import('../src/routes/feedback.js')
const { attachments } = await import('../src/routes/attachments.js')
const { attachToThread, sweepUploads, UNSENT_MS } = await import('../src/attachments.js')
const { scoped } = await import('../src/db.js')

const id = randomUUID().slice(0, 8)
const ids = { organization: `org-fb-${id}`, user: `user-fb-${id}`, member: `mem-fb-${id}` }
let workspaceId = ''
let sessionId = ''

const realGetSession = auth.api.getSession
const app = new Hono().route('/api/feedback', feedback).route('/api/attachments', attachments)

const send = (body: unknown) =>
  app.request('/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const cancel = (fileId: string) => app.request(`/api/attachments/${fileId}`, { method: 'DELETE' })

/** An upload of the member's, ready and not sent, as POST /attachments/uploads leaves one. */
async function upload(name = 'shot.png', createdAt = new Date()) {
  const row = await prisma.attachment.create({
    data: {
      organizationId: ids.organization,
      workspaceId,
      name,
      contentType: 'image/png',
      size: 10,
      source: 'upload',
      status: 'ready',
      uploadedByMemberId: ids.member,
      createdAt,
    },
  })
  return row.id
}

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Feedback test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Feedback test' },
  })
  workspaceId = workspace.id
  const where = { organizationId: ids.organization, workspaceId }
  const teammate = await prisma.teammate.create({ data: { ...where, name: 'Riley' } })
  const computer = await prisma.computer.create({
    data: { ...where, kind: 'member_machine', memberId: ids.member, name: 'Laptop' },
  })
  sessionId = (
    await prisma.session.create({
      data: {
        ...where,
        teammateId: teammate.id,
        startedByMemberId: ids.member,
        computerId: computer.id,
        title: 'A thread',
      },
    })
  ).id
  ;(auth.api as { getSession: unknown }).getSession = sessionStub(() => ({
    user: { id: ids.user },
    session: {
      id: `session-${id}`,
      activeOrganizationId: ids.organization,
      activeWorkspaceId: workspace.id,
    },
  }))
})

// Each test starts under the member's limits.
beforeEach(async () => {
  if (skip) return
  await prisma.feedback.deleteMany({ where: { organizationId: ids.organization } })
})

after(async () => {
  ;(auth.api as { getSession: unknown }).getSession = realGetSession
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

test('feedback keeps its files, and the sweep leaves them', { skip }, async () => {
  const files = [await upload('a.png'), await upload('b.png')]
  const res = await send({ text: 'The sidebar flickers', page: '/app', attachmentIds: files })
  assert.equal(res.status, 201, await res.clone().text())
  const { id: feedbackId } = (await res.json()) as { id: string }
  const rows = await prisma.attachment.findMany({ where: { id: { in: files } } })
  assert.deepEqual(
    rows.map((r) => r.feedbackId),
    [feedbackId, feedbackId],
  )
  // Long after: an unsent upload would be swept, one sent with feedback stays.
  await prisma.attachment.updateMany({
    where: { id: { in: files } },
    data: { createdAt: new Date(Date.now() - 2 * UNSENT_MS) },
  })
  await sweepUploads()
  assert.equal(await prisma.attachment.count({ where: { id: { in: files } } }), 2)
  // Nor can the composer's ✕ remove it now.
  assert.equal((await cancel(files[0]!)).status, 404)
})

test('two sends racing for a file: one gets it, the other stores nothing', { skip }, async () => {
  const file = await upload()
  const results = await Promise.all([
    send({ text: 'First', attachmentIds: [file] }),
    send({ text: 'Second', attachmentIds: [file] }),
  ])
  const statuses = results.map((r) => r.status).sort()
  assert.deepEqual(statuses, [201, 400])
  const won = (await results.find((r) => r.status === 201)!.json()) as { id: string }
  assert.equal((await prisma.attachment.findUnique({ where: { id: file } }))?.feedbackId, won.id)
  const stored = await prisma.feedback.findMany({ where: { organizationId: ids.organization } })
  assert.deepEqual(
    stored.map((f) => f.id),
    [won.id],
  )
})

test(
  'a file taken by one send is not split: a partial claim gives back what it took',
  {
    skip,
  },
  async () => {
    const mine = await upload('mine.png')
    const taken = await upload('taken.png')
    const first = await send({ text: 'First', attachmentIds: [taken] })
    assert.equal(first.status, 201)
    const second = await send({ text: 'Second', attachmentIds: [mine, taken] })
    assert.equal(second.status, 400)
    // The free file went back to unsent, so the member can still send or remove it.
    assert.equal((await prisma.attachment.findUnique({ where: { id: mine } }))?.feedbackId, null)
    assert.equal((await cancel(mine)).status, 204)
  },
)

test('Cancel racing a send: the file is either sent or gone, never both', { skip }, async () => {
  for (let i = 0; i < 5; i++) {
    const file = await upload(`race-${i}.png`)
    const [sent, removed] = await Promise.all([
      send({ text: `Race ${i}`, attachmentIds: [file] }),
      cancel(file),
    ])
    const row = await prisma.attachment.findUnique({ where: { id: file } })
    if (sent.status === 201) {
      assert.equal(removed.status, 404)
      assert.ok(row?.feedbackId, 'the sent file is kept with its feedback')
    } else {
      assert.equal(sent.status, 400)
      assert.equal(removed.status, 204)
      assert.equal(row, null)
    }
    await prisma.feedback.deleteMany({ where: { organizationId: ids.organization } })
  }
})

test('an upload old enough to be swept is not taken', { skip }, async () => {
  const old = await upload('old.png', new Date(Date.now() - UNSENT_MS + 60_000))
  const res = await send({ text: 'Late', attachmentIds: [old] })
  assert.equal(res.status, 400)
  assert.equal(await prisma.feedback.count({ where: { organizationId: ids.organization } }), 0)
})

test('one member cannot flood the team', { skip }, async () => {
  for (let i = 0; i < FEEDBACK_LIMITS.burst; i++)
    assert.equal((await send({ text: `Note ${i}` })).status, 201)
  const over = await send({ text: 'One more' })
  assert.equal(over.status, 429)
  assert.equal(
    await prisma.feedback.count({ where: { organizationId: ids.organization } }),
    FEEDBACK_LIMITS.burst,
  )
})

test('parallel sends cannot pass the last place', { skip }, async () => {
  const results = await Promise.all(
    Array.from({ length: FEEDBACK_LIMITS.burst + 3 }, (_, i) => send({ text: `At once ${i}` })),
  )
  const statuses = results.map((r) => r.status)
  assert.equal(statuses.filter((s) => s === 201).length, FEEDBACK_LIMITS.burst)
  assert.equal(statuses.filter((s) => s === 429).length, 3)
  assert.equal(
    await prisma.feedback.count({ where: { organizationId: ids.organization } }),
    FEEDBACK_LIMITS.burst,
  )
})

test('a message and feedback racing for a file: never both', { skip }, async () => {
  const db = scoped({ organizationId: ids.organization, workspaceId })
  const scope = { organizationId: ids.organization, workspaceId }
  for (let i = 0; i < 8; i++) {
    const file = await upload(`both-${i}.png`)
    const [sent, linked] = await Promise.allSettled([
      send({ text: `Both ${i}`, attachmentIds: [file] }).then((r) => r.status),
      attachToThread(db, scope, sessionId, [file], { memberId: ids.member }),
    ])
    const row = await prisma.attachment.findUnique({
      where: { id: file },
      include: { threads: true },
    })
    const inFeedback = Boolean(row?.feedbackId)
    const inThread = (row?.threads.length ?? 0) > 0
    assert.ok(!(inFeedback && inThread), `round ${i}: kept by both`)
    assert.equal(sent.status === 'fulfilled' && sent.value === 201, inFeedback)
    assert.equal(linked.status === 'fulfilled', inThread)
    await prisma.feedback.deleteMany({ where: { organizationId: ids.organization } })
  }
})
