import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A teammate's screen without a cloud computer (POST /teammates/:id/desktop,
// src/routes/teammates.ts): with billing on and no Cloud plan, the reply says `noCloud` for the
// panel to offer Brigade Cloud; with a plan whose computer is not there, it is the plain error.
// On the real auth against apps/api/.env's database; skipped without one.
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
// Billing on, with a key that reaches nothing: nothing here calls Stripe.
process.env.STRIPE_SECRET_KEY = 'sk_test_never_called'
delete process.env.TURNSTILE_SECRET_KEY

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "BillingSubscription" limit 1')
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
const { workspaces } = await import('../src/routes/workspaces.js')
const { teammates } = await import('../src/routes/teammates.js')

const app = new Hono()
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))
app.route('/api', workspaces)
app.route('/api/teammates', teammates)
app.onError((error, c) =>
  error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: String(error) }, 500),
)

const run = randomUUID().slice(0, 8)
const email = `ada-desktop-${run}@example.com`

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

/** Signed in with a mailed code (logged without Resend). */
async function signIn() {
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

let cookie: string
let workspaceId: string
let chief: string

before(async () => {
  if (skip) return
  cookie = await signIn()
  const made = await call('/api/me/first-workspace', { body: {}, cookie })
  assert.equal(made.status, 201, await made.clone().text())
  const member = await prisma.member.findFirstOrThrow({ where: { user: { email } } })
  const workspace = await prisma.workspace.findFirstOrThrow({
    where: { organizationId: member.organizationId },
  })
  workspaceId = workspace.id
  chief = (await prisma.teammate.findFirstOrThrow({ where: { workspaceId, kind: 'chief' } })).id
})

after(async () => {
  if (skip) return
  const members = await prisma.member.findMany({
    where: { user: { email } },
    select: { organizationId: true },
  })
  const organizations = members.map((m) => m.organizationId)
  await prisma.workspace.deleteMany({ where: { organizationId: { in: organizations } } })
  await prisma.organization.deleteMany({ where: { id: { in: organizations } } })
  await prisma.user.deleteMany({ where: { email } })
  await prisma.verification.deleteMany({ where: { identifier: { contains: run } } })
  await prisma.$disconnect()
})

const desktop = async () => {
  const response = await call(`/api/teammates/${chief}/desktop`, { body: {}, cookie })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('without a Cloud plan, the screen is told to offer it', { skip }, async () => {
  const { status, body } = await desktop()
  assert.equal(status, 409)
  assert.equal(body.noCloud, true)
  assert.match(String(body.error), /no cloud computer/)
})

test('with a plan but no computer, the plain error, no offer', { skip }, async () => {
  // Complimentary: active, with no Stripe subscription behind it.
  await prisma.billingSubscription.create({
    data: { workspaceId, plan: 'cloud', status: 'active' },
  })
  const { status, body } = await desktop()
  assert.equal(status, 409)
  assert.equal(body.noCloud, undefined)
  assert.match(String(body.error), /no cloud computer/)
})

test('an unknown teammate is still a 404', { skip }, async () => {
  const response = await call(`/api/teammates/nobody-${run}/desktop`, { body: {}, cookie })
  assert.equal(response.status, 404)
})
