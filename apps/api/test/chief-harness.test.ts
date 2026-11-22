import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A Chief that never ran moves to the workspace's only login (src/chief-harness.ts): a Mac's own
// Codex login, found once onboarding's page was closed, left a Chief on Claude Code that nothing
// could start. Against the local database of apps/api/.env, in an organization of its own removed
// at the end; skipped without a database to reach.
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
    await client.query('select 1 from "Teammate" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma, scoped } = await import('../src/db.js')
const { alignChief } = await import('../src/chief-harness.js')

const run = randomUUID().slice(0, 8)
const org = `org-chief-harness-${run}`
const users = { owner: `u-chief-owner-${run}`, member: `u-chief-member-${run}` }
const owner = `m-chief-owner-${run}`
const plain = `m-chief-member-${run}`

before(async () => {
  if (skip) return
  await prisma.organization.create({ data: { id: org, name: 'Chief harness', slug: org } })
  for (const [id, userId, role] of [
    [owner, users.owner, 'owner'],
    [plain, users.member, 'member'],
  ] as const) {
    await prisma.user.create({ data: { id: userId, name: role, email: `${userId}@example.com` } })
    await prisma.member.create({ data: { id, organizationId: org, userId, role } })
  }
})

after(async () => {
  if (skip) return
  await prisma.workspace.deleteMany({ where: { organizationId: org } })
  await prisma.organization.deleteMany({ where: { id: org } })
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } })
})

/** A workspace with its Chief, a Mac of `whose`, and the given ready logins on it. */
async function workspace(
  chiefHarness: 'claude_code' | 'codex' | 'pi',
  logins: string[],
  whose = owner,
) {
  const workspaceId = (
    await prisma.workspace.create({ data: { organizationId: org, name: `W ${randomUUID()}` } })
  ).id
  const db = scoped({ organizationId: org, workspaceId })
  const chief = (
    await db.teammate.create({
      data: { name: 'Chief', kind: 'chief', harness: chiefHarness },
    } as never)
  ).id
  const mac = (
    await db.computer.create({
      data: { kind: 'member_machine', memberId: whose, name: 'Kim’s Mac' },
    } as never)
  ).id
  for (const provider of logins)
    await db.account.create({
      data: {
        memberId: whose,
        computerId: mac,
        provider,
        source: 'machine',
        label: provider,
        status: 'ready',
        isDefault: true,
      },
    } as never)
  const harness = async () =>
    (await prisma.teammate.findUniqueOrThrow({ where: { id: chief } })).harness
  return { workspaceId, db, chief, mac, harness }
}

test("a Chief never in a thread moves to its owner's only login", { skip }, async () => {
  const w = await workspace('claude_code', ['codex'])
  assert.equal(await alignChief(w.workspaceId, owner), true)
  assert.equal(await w.harness(), 'codex')
  const audit = await prisma.auditEntry.findFirst({
    where: { targetId: w.chief, action: 'teammate.updated' },
  })
  assert.equal(audit?.actorType, 'system')
  // Once there, nothing more to move.
  assert.equal(await alignChief(w.workspaceId, owner), false)
})

test("a member's own login never moves the workspace's Chief", { skip }, async () => {
  // Their Mac's Codex is theirs alone: the owner could not run Chief on it.
  const w = await workspace('claude_code', ['codex'], plain)
  assert.equal(await alignChief(w.workspaceId, plain), false)
  assert.equal(await alignChief(w.workspaceId, owner), false)
  assert.equal(await w.harness(), 'claude_code')
})

test('a Chief whose login is there stays, even with the other one too', { skip }, async () => {
  const w = await workspace('claude_code', ['claude_code', 'codex'])
  assert.equal(await alignChief(w.workspaceId, owner), false)
  assert.equal(await w.harness(), 'claude_code')
})

test('a Chief that was in a thread keeps what it runs on', { skip }, async () => {
  const own = await workspace('claude_code', ['codex'])
  await own.db.session.create({
    data: {
      teammateId: own.chief,
      startedByMemberId: owner,
      computerId: own.mac,
      title: 'Its own',
      status: 'idle',
    } as never,
  })
  assert.equal(await alignChief(own.workspaceId, owner), false)
  assert.equal(await own.harness(), 'claude_code')
  // Called into another teammate's thread (a seat, not the thread's teammate).
  const called = await workspace('claude_code', ['codex'])
  const other = await called.db.teammate.create({
    data: { name: 'Ada', harness: 'codex' },
  } as never)
  const session = await called.db.session.create({
    data: {
      teammateId: other.id,
      startedByMemberId: owner,
      computerId: called.mac,
      title: 'With @Chief',
      status: 'idle',
    } as never,
  })
  await called.db.threadTeammate.create({
    data: { sessionId: session.id, teammateId: called.chief } as never,
  })
  await called.db.teammate.update({ where: { id: other.id }, data: { archivedAt: new Date() } })
  assert.equal(await alignChief(called.workspaceId, owner), false)
  assert.equal(await called.harness(), 'claude_code')
})

test(
  'a team set up already, a Chief on another harness, or no login: it stays',
  { skip },
  async () => {
    const team = await workspace('claude_code', ['codex'])
    await team.db.teammate.create({ data: { name: 'Bo', harness: 'claude_code' } } as never)
    assert.equal(await alignChief(team.workspaceId, owner), false)
    assert.equal(await team.harness(), 'claude_code')
    const pi = await workspace('pi', ['codex'])
    assert.equal(await alignChief(pi.workspaceId, owner), false)
    assert.equal(await pi.harness(), 'pi')
    const none = await workspace('claude_code', [])
    assert.equal(await alignChief(none.workspaceId, owner), false)
    assert.equal(await none.harness(), 'claude_code')
  },
)
