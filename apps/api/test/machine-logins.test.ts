import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A login found on a member's own computer (hello's machineLogins, or machine.logins once the
// runner could read it: src/hub/thread-events.ts syncMachineLogins) makes moot their sign-ins there
// for the same provider that never got through: those go, from the computer too, and the working
// login becomes the default. One that was used stays. Against apps/api/.env's database; skipped
// without one.
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
    await client.query('select 1 from "Account" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma } = await import('../src/db.js')
const { inHub } = await import('../src/hub/context.js')
const { syncMachineLogins } = await import('../src/hub/thread-events.js')

const run = randomUUID().slice(0, 8)
const org = `org-ml-${run}`
const memberId = `m-ml-${run}`
let workspaceId: string
let computer: { id: string; organizationId: string; workspaceId: string; name: string }

before(async () => {
  if (skip) return
  await prisma.organization.create({ data: { id: org, name: 'ML', slug: org } })
  await prisma.user.create({
    data: { id: `u-ml-${run}`, name: 'Camille', email: `u-ml-${run}@example.com` },
  })
  await prisma.member.create({
    data: { id: memberId, organizationId: org, userId: `u-ml-${run}`, role: 'owner' },
  })
  workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'ML' } })).id
  const made = await prisma.computer.create({
    data: {
      organizationId: org,
      workspaceId,
      kind: 'member_machine',
      memberId,
      name: 'MacBook Pro',
    },
  })
  computer = { id: made.id, organizationId: org, workspaceId, name: made.name }
})

after(async () => {
  if (skip) return
  await prisma.workspace.deleteMany({ where: { organizationId: org } })
  await prisma.organization.deleteMany({ where: { id: org } })
  await prisma.user.deleteMany({ where: { id: `u-ml-${run}` } })
})

function fakeHub() {
  const maps = new Map<string, Map<string, unknown>>()
  const sent: { type: string; account?: { id: string } }[] = []
  const hub = {
    workspaceId,
    durable: (key: string) => {
      if (!maps.has(key)) maps.set(key, new Map())
      return maps.get(key)
    },
    sendToRunner: (_computerId: string, message: { type: string }) => {
      sent.push(message)
      return true
    },
  }
  return { hub: hub as never, sent }
}

const account = (label: string, data: Record<string, unknown>) =>
  prisma.account.create({
    data: {
      organizationId: org,
      workspaceId,
      memberId,
      computerId: computer.id,
      provider: 'codex',
      source: 'brigade',
      label,
      status: 'needs_sign_in',
      ...data,
    } as never,
  })

test(
  'a login found on the computer removes the sign-ins there that never got through',
  { skip },
  async () => {
    const failed = await account('failed', { isDefault: true })
    const failedAgain = await account('failed again', {})
    const used = await account('used once', { lastUsageAt: new Date() })
    const { hub, sent } = fakeHub()
    await inHub(hub, () =>
      syncMachineLogins(computer, memberId, [{ provider: 'codex', loggedIn: true }]),
    )
    const left = await prisma.account.findMany({
      where: { computerId: computer.id, provider: 'codex' },
      orderBy: { createdAt: 'asc' },
    })
    assert.deepEqual(
      left.map((a) => [a.label, a.source, a.status, a.isDefault]),
      [
        ['used once', 'brigade', 'needs_sign_in', false],
        ['Codex on MacBook Pro', 'machine', 'ready', true],
      ],
    )
    // Their logins on the computer go too.
    assert.deepEqual(
      sent
        .filter((m) => m.type === 'account.remove')
        .map((m) => m.account?.id)
        .sort(),
      [failed.id, failedAgain.id].sort(),
    )
    assert.ok(!sent.some((m) => m.account?.id === used.id))
  },
)

test('no login found: nothing is removed', { skip }, async () => {
  const failed = await account('claude failed', { provider: 'claude_code' })
  const { hub, sent } = fakeHub()
  await inHub(hub, () =>
    syncMachineLogins(computer, memberId, [{ provider: 'claude_code', loggedIn: false }]),
  )
  assert.ok(await prisma.account.findUnique({ where: { id: failed.id } }))
  assert.equal(sent.length, 0)
})
