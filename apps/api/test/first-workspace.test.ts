import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import pg from 'pg'

// Onboarding's first step (POST /me/first-workspace, src/routes/workspaces.ts): someone in no
// organization gets one of their own and its first workspace, named after them, once per person
// even when two tabs ask at the same time; someone who has one is only moved to it. On the real
// auth against apps/api/.env's database; skipped without one.
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
process.env.PASSWORD_SIGN_IN = 'false'
process.env.RESEND_API_KEY = ''
process.env.MAIL_CODES_IN_LOG = 'true'
delete process.env.TURNSTILE_SECRET_KEY

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "id" from "Invitation" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { Hono } = await import('hono')
const { HTTPException } = await import('hono/http-exception')
const { auth } = await import('../src/auth.js')
const { prisma } = await import('../src/db.js')
const { env } = await import('../src/config.js')
const { workspaces, firstWorkspaceName, firstWorkspaceFaults } =
  await import('../src/routes/workspaces.js')
const { GETTING_STARTED } = await import('@brigade/contracts')

const app = new Hono()
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
app.route('/api', workspaces)
app.onError((error, c) =>
  error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: String(error) }, 500),
)

const run = randomUUID().slice(0, 8)
const emails: string[] = []
after(async () => {
  if (skip) return
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  })
  const organizations = (
    await prisma.member.findMany({
      where: { userId: { in: users.map((u) => u.id) } },
      select: { organizationId: true },
    })
  ).map((m) => m.organizationId)
  await prisma.workspace.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.organization.deleteMany({ where: { id: { in: organizations } } })
  await prisma.user.deleteMany({ where: { email: { in: emails } } })
  await prisma.verification.deleteMany({ where: { identifier: { contains: run } } })
  await prisma.$disconnect()
})

function call(path: string, init: { body?: unknown; cookie?: string } = {}) {
  return app.request(`${env.API_URL}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      origin: env.WEB_URL[0]!,
      ...(init.cookie && { cookie: init.cookie }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })
}

/** Signed in with a mailed code (logged without Resend); one session per call, as a tab. */
async function signIn(email: string) {
  if (!emails.includes(email)) emails.push(email)
  const lines: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void lines.push(args.join(' '))
  try {
    await call('/api/auth/email-otp/send-verification-otp', { body: { email, type: 'sign-in' } })
  } finally {
    console.log = log
  }
  const otp = lines.find((l) => l.startsWith(`sign-in code for ${email}: `))?.split(': ')[1]
  assert.ok(otp, 'the code is logged')
  const response = await call('/api/auth/sign-in/email-otp', { body: { email, otp } })
  assert.equal(response.status, 200, await response.clone().text())
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
}

type Me = {
  user: { id: string }
  activeOrganizationId: string | null
  activeWorkspaceId: string | null
}
const meOf = async (cookie: string) => (await (await call('/api/me', { cookie })).json()) as Me

test('the name: the first name, bounded, never an address', () => {
  assert.equal(firstWorkspaceName('Ada Lovelace'), "Ada's workspace")
  assert.equal(firstWorkspaceName('  '), 'My workspace')
  assert.equal(firstWorkspaceName('ada@example.com'), 'My workspace')
  // Within CreateWorkspace's 80 characters, whatever the name signed up with.
  assert.ok(firstWorkspaceName('x'.repeat(200)).length <= 80)
})

test('two tabs at once make one organization and one workspace', { skip }, async () => {
  const email = `ada-${run}@example.com`
  // Two sessions of one person, as two tabs after a sign-in in each.
  const [one, two] = [await signIn(email), await signIn(email)]
  const answers = await Promise.all([
    call('/api/me/first-workspace', { body: {}, cookie: one }),
    call('/api/me/first-workspace', { body: {}, cookie: two }),
  ])
  const bodies = (await Promise.all(answers.map((a) => a.json()))) as { created: boolean }[]
  assert.deepEqual(bodies.map((b) => b.created).sort(), [false, true])

  const { user } = await meOf(one)
  const memberships = await prisma.member.findMany({ where: { userId: user.id } })
  assert.equal(memberships.length, 1, 'one organization')
  assert.equal(memberships[0]!.role, 'owner')
  const organizationId = memberships[0]!.organizationId
  const made = await prisma.workspace.findMany({ where: { organizationId } })
  assert.equal(made.length, 1, 'one workspace')
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
  })
  assert.equal(made[0]!.name, organization.name, 'both named alike')

  // Both tabs are in it.
  for (const cookie of [one, two]) {
    const me = await meOf(cookie)
    assert.equal(me.activeOrganizationId, organizationId)
    assert.equal(me.activeWorkspaceId, made[0]!.id)
  }

  // Asked again later: nothing more is made.
  const again = await call('/api/me/first-workspace', { body: {}, cookie: one })
  assert.equal(((await again.json()) as { created: boolean }).created, false)
  assert.equal(await prisma.member.count({ where: { userId: user.id } }), 1)
})

test('a call cut after the commit is finished by the next', { skip }, async () => {
  const cookie = await signIn(`bob-${run}@example.com`)
  firstWorkspaceFaults.afterCommit = () => {
    throw new Error('cut')
  }
  try {
    const cut = await call('/api/me/first-workspace', { body: {}, cookie })
    assert.equal(cut.status, 500)
  } finally {
    firstWorkspaceFaults.afterCommit = undefined
  }
  const { user } = await meOf(cookie)
  const member = await prisma.member.findFirstOrThrow({ where: { userId: user.id } })
  const workspace = await prisma.workspace.findFirstOrThrow({
    where: { organizationId: member.organizationId },
  })
  // Made in the transaction: the workspace and its Chief, never one without the other.
  assert.equal(
    await prisma.teammate.count({ where: { workspaceId: workspace.id, kind: 'chief' } }),
    1,
  )
  const list = () =>
    prisma.document.count({
      where: { workspaceId: workspace.id, kind: 'library', path: GETTING_STARTED.path },
    })
  assert.equal(await list(), 0, 'the setup after the commit did not run')

  const again = await call('/api/me/first-workspace', { body: {}, cookie })
  assert.equal(again.status, 200, await again.clone().text())
  assert.equal(((await again.json()) as { created: boolean }).created, false)
  assert.equal(await list(), 1, 'the next call finished it')
  assert.equal(
    await prisma.teammate.count({ where: { workspaceId: workspace.id, kind: 'chief' } }),
    1,
  )
  assert.equal(
    await prisma.workspace.count({ where: { organizationId: member.organizationId } }),
    1,
  )
  const me = await meOf(cookie)
  assert.equal(me.activeWorkspaceId, workspace.id)
})
