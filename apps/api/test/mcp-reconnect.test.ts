import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Reconnect on an MCP App's account (from its ticket or its sheet): the sign-in renews that
// account, rather than adding a second one beside it, even when it cannot name the account (as
// Neon's did once its list_organizations reply changed shape). The local database of
// apps/api/.env, in an organization of its own removed at the end; without one, skipped.
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
    await client.query('select 1 from "Connection" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const id = randomUUID().slice(0, 8)
const ids = { organization: `org-reconnect-${id}`, user: `user-reconnect-${id}` }
const member = `mem-reconnect-${id}`
const other = `mem-reconnect-other-${id}`
let scope: { organizationId: string; workspaceId: string; memberId: string; role: 'owner' }
let db: Awaited<typeof import('../src/db.js')>['prisma']

before(async () => {
  if (skip) return
  const { prisma } = await import('../src/db.js')
  db = prisma
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Reconnect test', slug: ids.organization },
  })
  for (const [userId, memberId] of [
    [ids.user, member],
    [`${ids.user}-other`, other],
  ] as const) {
    await prisma.user.create({
      data: { id: userId, name: 'Ada', email: `${userId}@example.com` },
    })
    await prisma.member.create({
      data: { id: memberId, organizationId: ids.organization, userId, role: 'owner' },
    })
  }
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Reconnect test' },
  })
  scope = {
    organizationId: ids.organization,
    workspaceId: workspace.id,
    memberId: member,
    role: 'owner',
  }
})
after(async () => {
  if (skip) return
  await db.organization.deleteMany({ where: { id: ids.organization } })
  await db.user.deleteMany({ where: { id: { in: [ids.user, `${ids.user}-other`] } } })
  await db.$disconnect()
})

/** A Neon account of the member's whose sign-in expired, as in the Neon App's own row. */
async function expiredNeon(fields: { externalAccount?: string | null; createdBy?: string } = {}) {
  const { scoped } = await import('../src/db.js')
  const { appFor, appKey } = await import('../src/apps.js')
  const sdb = scoped(scope)
  const app = await appFor(sdb, scope, appKey('neon', randomUUID()), null)
  return sdb.connection.create({
    data: {
      id: randomUUID(),
      appId: app.id,
      kind: 'neon',
      label: 'Neon',
      externalAccount: fields.externalAccount === undefined ? 'Chaindesk' : fields.externalAccount,
      status: 'needs_reauth',
      reach: 'workspace',
      createdByMemberId: fields.createdBy ?? member,
    } as never,
  })
}

test(
  'a Reconnect that cannot name the account renews the one it was started on',
  { skip },
  async () => {
    const { scoped } = await import('../src/db.js')
    const { createConnection, reconnectedRow } = await import('../src/routes/connections.js')
    const sdb = scoped(scope)
    const row = await expiredNeon()
    const before = await sdb.connection.count({ where: { kind: 'neon' } })

    const repair = await reconnectedRow(sdb, scope, 'neon', row.id, null, { mcpUrl: null })
    assert.equal(repair, row.id)
    const renewed = await createConnection(
      scope,
      { kind: 'neon', label: 'Neon', externalAccount: null },
      { accessToken: 'new-token' },
      undefined,
      repair,
    )
    assert.equal(renewed.id, row.id)
    assert.equal(await sdb.connection.count({ where: { kind: 'neon' } }), before)
    const after = await sdb.connection.findFirstOrThrow({ where: { id: row.id } })
    assert.equal(after.status, 'active')
    assert.equal(after.externalAccount, 'Chaindesk')
  },
)

test(
  'a Reconnect renews the account it names, and names one that had no name',
  { skip },
  async () => {
    const { scoped } = await import('../src/db.js')
    const { reconnectedRow } = await import('../src/routes/connections.js')
    const sdb = scoped(scope)
    const named = await expiredNeon()
    assert.equal(
      await reconnectedRow(sdb, scope, 'neon', named.id, 'Chaindesk', { mcpUrl: null }),
      named.id,
    )
    const nameless = await expiredNeon({ externalAccount: null })
    assert.equal(
      await reconnectedRow(sdb, scope, 'neon', nameless.id, 'Chaindesk', { mcpUrl: null }),
      nameless.id,
    )
    const row = await sdb.connection.findFirstOrThrow({ where: { id: nameless.id } })
    assert.equal(row.externalAccount, 'Chaindesk')
  },
)

test('a Reconnect never renews another account, nor another member’s', { skip }, async () => {
  const { scoped } = await import('../src/db.js')
  const { reconnectedRow } = await import('../src/routes/connections.js')
  const sdb = scoped(scope)
  const row = await expiredNeon()
  // Signed in to another organization instead: a row of its own.
  assert.equal(
    await reconnectedRow(sdb, scope, 'neon', row.id, 'Other org', { mcpUrl: null }),
    undefined,
  )
  // Another App's sign-in, or another region's server.
  assert.equal(
    await reconnectedRow(sdb, scope, 'supabase', row.id, null, { mcpUrl: null }),
    undefined,
  )
  assert.equal(
    await reconnectedRow(sdb, scope, 'neon', row.id, null, { mcpUrl: 'https://eu.example' }),
    undefined,
  )
  const theirs = await expiredNeon({ createdBy: other })
  assert.equal(
    await reconnectedRow(sdb, scope, 'neon', theirs.id, null, { mcpUrl: null }),
    undefined,
  )
})
