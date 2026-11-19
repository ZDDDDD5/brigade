import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { loginOf } from '@brigade/contracts'

// Teammates on Antigravity (docs/harnesses.md), behind the antigravity_harness feature: a thread's
// spec says Antigravity and runs on the member's Google accounts (Account.provider antigravity),
// never on a Claude or ChatGPT one, nor a Claude teammate on a Google one; without the feature it
// does not run. Against the API's development database (apps/api/.env), in an organization of its
// own removed at the end; skipped when no database answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

test('an Antigravity teammate runs on its own login', () => {
  assert.equal(loginOf('antigravity', null), 'antigravity')
  assert.equal(loginOf('antigravity', 'gemini-4-neon'), 'antigravity')
})

describe(
  'a thread with a teammate on Antigravity',
  { skip: !database && 'no database answers' },
  () => {
    const suffix = randomUUID().slice(0, 8)
    const org = `org-agy-${suffix}`
    const userId = `user-agy-${suffix}`
    const memberId = `member-agy-${suffix}`
    let workspaceId = ''
    let db: ReturnType<typeof scoped>
    let cloud = ''
    const accounts = {} as Record<'claude' | 'google' | 'second', string>
    let flagBefore: Awaited<ReturnType<typeof prisma.featureFlag.findUnique>> = null

    const open = (on: boolean) =>
      prisma.featureFlag.upsert({
        where: { key: 'antigravity_harness' },
        create: { key: 'antigravity_harness', workspaceIds: on ? [workspaceId] : [] },
        update: { everyone: false, emails: [], workspaceIds: on ? [workspaceId] : [] },
      })

    before(async () => {
      await prisma.organization.create({ data: { id: org, name: 'Agy', slug: org } })
      await prisma.user.create({ data: { id: userId, name: 'Ada', email: `${userId}@test.local` } })
      await prisma.member.create({
        data: { id: memberId, organizationId: org, userId, role: 'owner' },
      })
      workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Agy' } }))
        .id
      db = scoped({ organizationId: org, workspaceId })
      flagBefore = await prisma.featureFlag.findUnique({ where: { key: 'antigravity_harness' } })
      cloud = (
        await db.computer.create({
          data: { kind: 'cloud', name: 'Cloud computer', status: 'running' },
        } as never)
      ).id
      const account = async (provider: string, label: string, isDefault: boolean) =>
        (
          await db.account.create({
            data: {
              memberId,
              computerId: cloud,
              provider,
              label,
              status: 'ready',
              isDefault,
              source: 'brigade',
            },
          } as never)
        ).id
      accounts.claude = await account('claude_code', 'Claude', true)
      accounts.google = await account('antigravity', 'Google', true)
      accounts.second = await account('antigravity', 'Second Google', false)
    })

    after(async () => {
      if (flagBefore) {
        const { key: _key, updatedAt: _at, ...rest } = flagBefore
        await prisma.featureFlag.update({ where: { key: 'antigravity_harness' }, data: rest })
      } else await prisma.featureFlag.deleteMany({ where: { key: 'antigravity_harness' } })
      if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } })
      await prisma.member.deleteMany({ where: { organizationId: org } })
      await prisma.organization.deleteMany({ where: { id: org } })
      await prisma.user.deleteMany({ where: { id: userId } })
    })

    async function thread(harness: string, model: string | null, accountId: string | null) {
      const teammate = await db.teammate.create({
        data: { name: `Gem ${randomUUID().slice(0, 4)}`, harness, model },
      } as never)
      const session = await db.session.create({
        data: {
          teammateId: teammate.id,
          startedByMemberId: memberId,
          computerId: cloud,
          accountId,
          title: 'Antigravity',
          status: 'idle',
        } as never,
      })
      await db.threadTeammate.create({
        data: { sessionId: session.id, teammateId: teammate.id } as never,
      })
      return session.id
    }

    test('runs on a Google account, with the member’s other Google accounts to fall back on', async () => {
      const { specFor, loadThread } = await import('../src/thread-spec.js')
      await open(true)
      // Its thread last ran on the Claude account: Antigravity never takes it.
      const id = await thread('antigravity', 'gemini-4-neon', accounts.claude)
      const spec = await specFor(db, await loadThread(db, id))
      assert.equal(spec.teammate.harness, 'antigravity')
      assert.equal(spec.teammate.model, 'gemini-4-neon')
      assert.deepEqual(spec.account, {
        id: accounts.google,
        provider: 'antigravity',
        source: 'brigade',
      })
      assert.deepEqual(
        spec.fallbacks.map((a) => a.id),
        [accounts.second],
      )
    })

    test('a Claude Code teammate never runs on a Google account', async () => {
      const { specFor, loadThread } = await import('../src/thread-spec.js')
      const id = await thread('claude_code', null, accounts.google)
      const spec = await specFor(db, await loadThread(db, id))
      assert.equal(spec.account.id, accounts.claude)
      assert.ok(spec.fallbacks.every((a) => a.provider === 'claude_code'))
    })

    test('without the feature, it does not run', async () => {
      const { specFor, loadThread } = await import('../src/thread-spec.js')
      await open(false)
      const id = await thread('antigravity', null, accounts.google)
      await assert.rejects(specFor(db, await loadThread(db, id)), /not open to this workspace/)
    })
  },
)
