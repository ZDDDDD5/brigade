import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'
import { sessionStub } from './session-stub.js'

// Onboarding's setup thread with the chief (POST /api/threads with `setup`), against the API's
// development database (apps/api/.env), in an organization of its own removed at the end;
// skipped when no database answers:
// - started twice at once (onboarding open in a browser and in Brigade.app, both seeing the AI
//   account ready on the same tick), it is one thread, whose id both get back, and its first
//   message reaches the runner once;
// - started again later, it is the same thread: nothing new is made or sent;
// - only the chief sets up a team, and only an owner or admin starts it, as onboarding offers
//   it only to them: a member's start would take the thread the owner's onboarding opens;
// - another start waits for one being made to start: one that did not start (its computer
//   offline) is gone, and this start makes it rather than send the member to it.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

type Sent = { type: string; [key: string]: unknown }

const prompts = (sent: Sent[], sessionId: string) =>
  sent.filter(
    (m) =>
      m.type === 'thread.prompt' &&
      (m.thread as { sessionId?: string } | undefined)?.sessionId === sessionId,
  )

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

describe("a workspace's setup thread", { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {} as Record<
    'org' | 'user' | 'member' | 'carol' | 'workspace' | 'computer' | 'runner' | 'chief' | 'riley',
    string
  >
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  let app: Hono
  let restore: () => void
  let sent: Sent[]
  let close: () => void
  let signedIn: string

  before(async () => {
    const { auth } = await import('../src/auth.js')
    const { threads } = await import('../src/routes/threads.js')
    ids.org = `org-setup-${suffix}`
    ids.user = `user-setup-${suffix}`
    ids.member = `m-setup-${suffix}`
    await prisma.organization.create({
      data: { id: ids.org, name: 'Setup', slug: `setup-${suffix}` },
    })
    await prisma.user.create({
      data: { id: ids.user, name: 'Ada', email: `${ids.user}@test.local` },
    })
    await prisma.user.create({
      data: { id: `${ids.user}-carol`, name: 'Carol', email: `${ids.user}-carol@test.local` },
    })
    ids.carol = `m-setup-carol-${suffix}`
    await prisma.member.createMany({
      data: [
        { id: ids.member, organizationId: ids.org, userId: ids.user, role: 'owner' },
        { id: ids.carol, organizationId: ids.org, userId: `${ids.user}-carol`, role: 'member' },
      ],
    })
    signedIn = ids.user
    ids.workspace = (
      await prisma.workspace.create({ data: { organizationId: ids.org, name: 'Setup' } })
    ).id
    scope = { organizationId: ids.org, workspaceId: ids.workspace }
    db = scoped(scope)
    ids.computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.member, name: 'Laptop', status: 'running' },
      } as never)
    ).id
    ids.runner = (
      await db.runner.create({
        data: { computerId: ids.computer, tokenHash: `hash-${suffix}` },
      } as never)
    ).id
    await db.account.create({
      data: {
        memberId: ids.member,
        computerId: ids.computer,
        provider: 'claude_code',
        label: 'Claude',
        status: 'ready',
      },
    } as never)
    ids.chief = (
      await db.teammate.create({ data: { name: `Chief ${suffix}`, kind: 'chief' } } as never)
    ).id
    ids.riley = (await db.teammate.create({ data: { name: `Riley ${suffix}` } } as never)).id
    const getSession = auth.api.getSession
    ;(auth.api as { getSession: unknown }).getSession = sessionStub(() => ({
      user: { id: signedIn },
      session: {
        id: `session-${suffix}`,
        activeOrganizationId: ids.org,
        activeWorkspaceId: ids.workspace,
      },
    }))
    restore = () => ((auth.api as { getSession: unknown }).getSession = getSession)
    app = new Hono().route('/api/threads', threads)
    sent = []
    const { runnerSocket } = await import('../src/hub.js')
    const { PROTOCOL_VERSION } = await import('@brigade/contracts')
    const handle = runnerSocket({ id: ids.runner, computerId: ids.computer, ...scope })
    const ws = { send: (raw: string) => sent.push(JSON.parse(raw)), close: () => {} }
    handle.onMessage(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        version: '0.0.0',
        platform: 'linux-x64',
      }),
      ws as never,
    )
    await until(() => sent.some((m) => m.type === 'welcome'), 'the welcome')
    close = () => handle.onClose()
  })

  after(async () => {
    close?.()
    restore?.()
    if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
    await prisma.member.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.user.deleteMany({ where: { id: { in: [ids.user, `${ids.user}-carol`] } } })
  })

  const start = (body: Record<string, unknown>) =>
    app.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ computerId: ids.computer, ...body }),
    })

  const chiefThreads = () =>
    db.session.findMany({ where: { teammateId: ids.chief }, select: { id: true } })

  test('started twice at once, it is one thread, whose id both get back', async () => {
    const text = 'Hi Chief, I just started on Brigade. Help me set up my team.'
    const answers = await Promise.all(
      [0, 1, 2].map(() => start({ teammateId: ids.chief, text, setup: true })),
    )
    for (const res of answers)
      assert.ok([200, 201].includes(res.status), `${res.status} ${await res.clone().text()}`)
    assert.equal(answers.filter((res) => res.status === 201).length, 1)
    const returned = new Set(
      await Promise.all(answers.map(async (res) => ((await res.json()) as { id: string }).id)),
    )
    const made = await chiefThreads()
    assert.equal(made.length, 1)
    assert.deepEqual([...returned], [made[0]!.id])
    await until(() => prompts(sent, made[0]!.id).length > 0, 'the message on its runner')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(prompts(sent, made[0]!.id).length, 1)
  })

  test('started again later, it is the same thread, and nothing is sent', async () => {
    const [made] = await chiefThreads()
    const before = sent.length
    const res = await start({ teammateId: ids.chief, text: 'Again', setup: true })
    assert.equal(res.status, 200, await res.clone().text())
    assert.equal(((await res.json()) as { id: string }).id, made!.id)
    assert.equal((await chiefThreads()).length, 1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(prompts(sent.slice(before), made!.id), [])
  })

  test('only the chief sets up a team', async () => {
    const res = await start({ teammateId: ids.riley, text: 'Set up', setup: true })
    assert.equal(res.status, 400, await res.clone().text())
    assert.equal(await db.session.count({ where: { teammateId: ids.riley } }), 0)
  })

  test('a member who is not an owner or admin does not start it', async () => {
    await db.session.deleteMany({ where: { teammateId: ids.chief } })
    signedIn = `${ids.user}-carol`
    try {
      // On a computer of her own, which she may start threads on.
      const laptop = await db.computer.create({
        data: { kind: 'member_machine', memberId: ids.carol, name: 'Hers', status: 'running' },
      } as never)
      const res = await start({
        teammateId: ids.chief,
        computerId: laptop.id,
        text: 'Set up',
        setup: true,
      })
      assert.equal(res.status, 403, await res.clone().text())
      assert.equal((await chiefThreads()).length, 0)
    } finally {
      signedIn = ids.user
    }
  })

  test('one being made is waited for: gone, this start makes it', async () => {
    const { setupThreadId } = await import('../src/routes/threads.js')
    const id = setupThreadId(ids.workspace, ids.chief)
    // Another start's thread, made and not started yet: nothing kept for its computer.
    await db.session.create({
      data: {
        id,
        teammateId: ids.chief,
        startedByMemberId: ids.member,
        computerId: ids.computer,
        title: 'Setup',
      } as never,
    })
    const answer = start({ teammateId: ids.chief, text: 'Set up', setup: true })
    await new Promise((resolve) => setTimeout(resolve, 600))
    // It did not start, and goes (dropUnstarted).
    await db.session.deleteMany({ where: { id } })
    const res = await answer
    assert.equal(res.status, 201, await res.clone().text())
    assert.equal(((await res.json()) as { id: string }).id, id)
    await until(() => prompts(sent, id).length > 0, 'the message on its runner')
  })
})
