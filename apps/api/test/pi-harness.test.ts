import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { isPiAccount, loginOf } from '@brigade/contracts'

// Teammates on Pi (docs/harnesses.md), behind the pi_harness feature: a thread's spec says Pi, and
// runs on the login of its model's vendor, only on accounts set aside for Pi (named "Pi …"), never
// falling back to the member's others; without the feature it does not run. Against the API's
// development database (apps/api/.env), in an organization of its own removed at the end; skipped
// when no database answers.
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

test('a Pi teammate runs on its model’s login, on accounts named for Pi', () => {
  assert.equal(loginOf('pi', 'claude-sonnet-5-5'), 'claude_code')
  assert.equal(loginOf('pi', 'gpt-6.1-sol'), 'codex')
  // Default: Opus, on Claude.
  assert.equal(loginOf('pi', null), 'claude_code')
  assert.equal(loginOf('codex', null), 'codex')
  assert.ok(isPiAccount('Pi'))
  assert.ok(isPiAccount('pi benchmark'))
  assert.ok(!isPiAccount('Pipeline'))
  assert.ok(!isPiAccount('Claude'))
})

describe('a thread with a teammate on Pi', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const org = `org-pi-${suffix}`
  const userId = `user-pi-${suffix}`
  const memberId = `member-pi-${suffix}`
  let workspaceId = ''
  let db: ReturnType<typeof scoped>
  let cloud = ''
  const accounts = {} as Record<'main' | 'pi' | 'codexPi', string>
  let flagBefore: Awaited<ReturnType<typeof prisma.featureFlag.findUnique>> = null

  const open = (on: boolean) =>
    prisma.featureFlag.upsert({
      where: { key: 'pi_harness' },
      create: { key: 'pi_harness', workspaceIds: on ? [workspaceId] : [] },
      update: { everyone: false, emails: [], workspaceIds: on ? [workspaceId] : [] },
    })

  before(async () => {
    await prisma.organization.create({ data: { id: org, name: 'Pi', slug: org } })
    await prisma.user.create({ data: { id: userId, name: 'Ada', email: `${userId}@test.local` } })
    await prisma.member.create({
      data: { id: memberId, organizationId: org, userId, role: 'owner' },
    })
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Pi' } })).id
    db = scoped({ organizationId: org, workspaceId })
    flagBefore = await prisma.featureFlag.findUnique({ where: { key: 'pi_harness' } })
    cloud = (
      await db.computer.create({
        data: { kind: 'cloud', name: 'Cloud computer', status: 'running' },
      } as never)
    ).id
    const account = async (provider: string, label: string, isDefault: boolean) =>
      (
        await db.account.create({
          data: { memberId, computerId: cloud, provider, label, status: 'ready', isDefault },
        } as never)
      ).id
    accounts.main = await account('claude_code', 'Claude', true)
    accounts.pi = await account('claude_code', 'Pi benchmark', false)
    accounts.codexPi = await account('codex', 'Pi', false)
  })

  after(async () => {
    if (flagBefore) {
      const { key: _key, updatedAt: _at, ...rest } = flagBefore
      await prisma.featureFlag.update({ where: { key: 'pi_harness' }, data: rest })
    } else await prisma.featureFlag.deleteMany({ where: { key: 'pi_harness' } })
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } })
    await prisma.member.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: userId } })
  })

  async function thread(model: string | null, accountId: string) {
    const teammate = await db.teammate.create({
      data: { name: `Pia ${randomUUID().slice(0, 4)}`, harness: 'pi', model },
    } as never)
    const session = await db.session.create({
      data: {
        teammateId: teammate.id,
        startedByMemberId: memberId,
        computerId: cloud,
        accountId,
        title: 'Benchmark',
        status: 'idle',
      } as never,
    })
    await db.threadTeammate.create({
      data: { sessionId: session.id, teammateId: teammate.id } as never,
    })
    return session.id
  }

  test('runs on the account set aside for Pi, with no other to fall back on', async () => {
    const { specFor, loadThread } = await import('../src/thread-spec.js')
    await open(true)
    // Started on the member's main Claude account: Pi still takes only the one named for it.
    const id = await thread('claude-sonnet-5-5', accounts.main)
    const spec = await specFor(db, await loadThread(db, id))
    assert.equal(spec.teammate.harness, 'pi')
    assert.equal(spec.teammate.model, 'claude-sonnet-5-5')
    assert.deepEqual(spec.account, { id: accounts.pi, provider: 'claude_code', source: 'machine' })
    assert.deepEqual(spec.fallbacks, [])
  })

  test('a GPT model runs on the ChatGPT account named for Pi', async () => {
    const { specFor, loadThread } = await import('../src/thread-spec.js')
    await open(true)
    const id = await thread('gpt-6.1-sol', accounts.main)
    const spec = await specFor(db, await loadThread(db, id))
    assert.equal(spec.account.id, accounts.codexPi)
    assert.equal(spec.account.provider, 'codex')
  })

  test('without the feature, or without an account named for Pi, it does not run', async () => {
    const { specFor, loadThread } = await import('../src/thread-spec.js')
    await open(false)
    const id = await thread('claude-sonnet-5-5', accounts.pi)
    await assert.rejects(specFor(db, await loadThread(db, id)), /not open to this workspace/)
    await open(true)
    await db.account.updateMany({ where: { id: accounts.pi }, data: { label: 'Second Claude' } })
    try {
      await assert.rejects(specFor(db, await loadThread(db, id)), /name starts with "Pi"/)
    } finally {
      await db.account.updateMany({ where: { id: accounts.pi }, data: { label: 'Pi benchmark' } })
    }
  })
})
