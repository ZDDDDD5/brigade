// Brigade.app's notifications, against the checkout's local database (apps/api/.env's
// DATABASE_URL): skipped where there is none. The sweep queues what it would push for each
// Brigade.app that runs, and the app's fetch takes it. No web push here: the app needs none.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { after, before, test } from 'node:test'
import type { DesktopMessages } from '@brigade/contracts'

const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile)
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
// No web push: Brigade.app alone.
delete process.env.VAPID_PUBLIC_KEY
delete process.env.VAPID_PRIVATE_KEY

const { prisma, scoped } = await import('../src/db.js')
const { hashToken } = await import('../src/hub.js')
const { sendTest, sweep } = await import('../src/notifications.js')
const { desktopNotifications } = await import('../src/routes/desktop-notifications.js')

const reachable = await prisma.$queryRawUnsafe('select 1').then(
  () => true,
  () => false,
)
const skip = reachable ? false : 'no local database (apps/api/.env)'
const id = () => randomUUID()

let organizationId = ''
let workspaceId = ''
let memberId = ''
let userId = ''
let threadId = ''
const db = () => scoped({ organizationId, workspaceId })

before(async () => {
  if (!reachable) return
  organizationId = (
    await prisma.organization.create({
      data: { id: id(), name: 'Desktop notifications', slug: `test-${id()}` },
    })
  ).id
  userId = (
    await prisma.user.create({ data: { id: id(), name: 'Ada', email: `${id()}@test.invalid` } })
  ).id
  memberId = (
    await prisma.member.create({ data: { id: id(), organizationId, userId, role: 'member' } })
  ).id
  workspaceId = (await prisma.workspace.create({ data: { organizationId, name: 'Test' } })).id
  const teammateId = (await db().teammate.create({ data: { name: 'Sam' } as never })).id
  const computerId = (
    await db().computer.create({ data: { kind: 'cloud', name: 'Test' } as never })
  ).id
  threadId = (
    await db().session.create({
      data: { teammateId, computerId, title: 'Refunds', startedByMemberId: memberId } as never,
    })
  ).id
})

after(async () => {
  if (reachable && organizationId) {
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  }
  await prisma.$disconnect()
})

/** Each test starts with no app and nothing sent. */
async function fresh() {
  await prisma.desktopDevice.deleteMany({ where: { userId } })
  await prisma.pushNotice.deleteMany({ where: { memberId } })
  await prisma.ticket.deleteMany({ where: { sessionId: threadId } })
}

/** A Brigade.app of the member's, and its token; `seen` its last fetch. */
async function app(seen = new Date()) {
  const token = randomBytes(32).toString('base64url')
  const device = await prisma.desktopDevice.create({
    data: { userId, tokenHash: hashToken(token), platform: 'darwin', lastSeenAt: seen },
  })
  return { id: device.id, token }
}

const fetchAs = async (token: string) => {
  const response = await desktopNotifications.request('/', {
    headers: { authorization: `Bearer ${token}` },
  })
  return { status: response.status, body: (await response.json()) as DesktopMessages }
}

const question = (title: string) =>
  db().ticket.create({
    data: { sessionId: threadId, type: 'question', title, payload: { memberId } } as never,
  })

test(
  'a question waiting on the member reaches the Brigade.app that runs, once',
  { skip },
  async () => {
    await fresh()
    const running = await app()
    // Not fetched for 10 minutes: Brigade.app isn't running there, nothing is queued for it.
    const asleep = await app(new Date(Date.now() - 10 * 60_000))
    const ticket = await question('Which plan should the refund go to?')
    const t0 = new Date()
    await sweep(t0, organizationId)
    await sweep(new Date(t0.getTime() + 61_000), organizationId)

    const { status, body } = await fetchAs(running.token)
    assert.equal(status, 200)
    assert.equal(body.messages.length, 1)
    assert.equal(body.messages[0]!.title, 'Sam has a question')
    assert.equal(body.messages[0]!.body, 'Which plan should the refund go to?')
    assert.equal(body.messages[0]!.url, `/app/threads/${threadId}?workspace=${workspaceId}`)
    assert.equal(body.messages[0]!.tag, threadId)
    assert.equal(body.messages[0]!.badge, 1)
    // Taken: the next fetch has nothing.
    assert.deepEqual((await fetchAs(running.token)).body.messages, [])
    assert.deepEqual((await fetchAs(asleep.token)).body.messages, [])
    // Sent: the notice says so, so it isn't sent again.
    const notice = await prisma.pushNotice.findFirstOrThrow({
      where: { memberId, key: `needs:${threadId}` },
    })
    assert.equal(notice.pushed, true)
    await prisma.ticket.delete({ where: { id: ticket.id } })
    await prisma.desktopDevice.deleteMany({ where: { userId } })
  },
)

test('with no Brigade.app running, the push waits for one', { skip }, async () => {
  await fresh()
  const later = await app(new Date(Date.now() - 10 * 60_000))
  const ticket = await question('Ship it?')
  const t0 = new Date()
  await sweep(t0, organizationId)
  await sweep(new Date(t0.getTime() + 61_000), organizationId)
  // The member has no device that runs: not even swept.
  assert.equal(
    (await prisma.pushNotice.findFirst({ where: { memberId, key: `needs:${threadId}` } }))
      ?.sentAt ?? null,
    null,
  )
  // Its fetch says it runs again (as of the sweeps' clock): the next sweeps queue the push for it.
  assert.deepEqual((await fetchAs(later.token)).body.messages, [])
  await prisma.desktopDevice.update({
    where: { id: later.id },
    data: { lastSeenAt: new Date(t0.getTime() + 120_000) },
  })
  await sweep(new Date(t0.getTime() + 62_000), organizationId)
  await sweep(new Date(t0.getTime() + 123_000), organizationId)
  const { body } = await fetchAs(later.token)
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0]!.body, 'Ship it?')
  await prisma.ticket.delete({ where: { id: ticket.id } })
  await prisma.desktopDevice.deleteMany({ where: { userId } })
})

test('a test notification, an unknown token, and turning it off', { skip }, async () => {
  await fresh()
  const device = await app()
  const result = await sendTest(userId)
  assert.deepEqual(result, { devices: 1, sent: 1, errors: [] })
  const { body } = await fetchAs(device.token)
  assert.equal(body.messages[0]!.tag, 'brigade-test')

  assert.equal((await fetchAs('not-a-token')).status, 401)
  const removed = await desktopNotifications.request('/', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${device.token}` },
  })
  assert.equal(removed.status, 204)
  assert.equal(await prisma.desktopDevice.count({ where: { userId } }), 0)
  assert.equal((await fetchAs(device.token)).status, 401)
})
