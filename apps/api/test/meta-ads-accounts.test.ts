import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A Meta sign-in renews the member's account issued to the same Facebook user (its ID, kept with
// the token), never one that only shares its name: two people may be called the same, and anyone
// may rename themselves. Against the local database of apps/api/.env, in an organization of its
// own removed at the end; skipped without a database to reach.
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

const { prisma, scoped } = await import('../src/db.js')
const { createConnection, metaConnectionOf } = await import('../src/routes/connections.js')
const { openSecret } = await import('../src/vault.js')

const run = randomUUID().slice(0, 8)
const org = `org-meta-${run}`
const userId = `u-meta-${run}`
const memberId = `m-meta-${run}`
let workspaceId: string
const scope = () => ({ organizationId: org, workspaceId, userId, memberId, role: 'owner' as const })

/** A sign-in as the callback makes it: matched by Meta user ID, never by name. */
async function signIn(user: string, name: string, token: string) {
  const repair = await metaConnectionOf(scope(), user)
  return createConnection(
    scope(),
    { kind: 'meta_ads', label: 'Meta Ads', externalAccount: name },
    { accessToken: token, expiresAt: 0, userId: user },
    undefined,
    repair,
    false,
  )
}
const tokenOf = async (id: string) => {
  const db = scoped(scope())
  const row = await db.connection.findFirst({ where: { id } })
  return (await openSecret<{ accessToken: string }>(db, scope(), row!.vaultSecretId!)).accessToken
}

before(async () => {
  if (skip) return
  await prisma.organization.create({ data: { id: org, name: 'Meta', slug: org } })
  await prisma.user.create({ data: { id: userId, name: 'ada', email: `${userId}@example.com` } })
  await prisma.member.create({ data: { id: memberId, organizationId: org, userId, role: 'owner' } })
  workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Meta' } })).id
})

after(async () => {
  if (skip) return
  await prisma.workspace.deleteMany({ where: { organizationId: org } })
  await prisma.organization.deleteMany({ where: { id: org } })
  await prisma.user.deleteMany({ where: { id: userId } })
})

test('two Facebook users with the same name get an account each', { skip }, async () => {
  const first = await signIn('fb-1', 'Sam Lee', 'token-1')
  const second = await signIn('fb-2', 'Sam Lee', 'token-2')
  assert.notEqual(first.id, second.id)
  assert.equal(await tokenOf(first.id), 'token-1')
  assert.equal(await tokenOf(second.id), 'token-2')
})

test('the same Facebook user, renamed, renews its account', { skip }, async () => {
  const before = await signIn('fb-3', 'Old Name', 'token-3')
  await scoped(scope()).connection.updateMany({
    where: { id: before.id },
    data: { status: 'needs_reauth', settings: { accounts: [] } },
  })
  const again = await signIn('fb-3', 'New Name', 'token-4')
  assert.equal(again.id, before.id)
  assert.equal(again.status, 'active')
  assert.equal(await tokenOf(before.id), 'token-4')
})
