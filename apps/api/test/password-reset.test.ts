import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import pg from 'pg'

// Password resets and changes are closed (src/auth.ts): no reset code is ever made, so nobody
// can guess one and set a password on someone else's account. On the real auth against the
// local database of apps/api/.env; without a database to reach, skipped.
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
delete process.env.TURNSTILE_SECRET_KEY

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "id" from "Verification" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { auth } = await import('../src/auth.js')
const { prisma } = await import('../src/db.js')
const { env } = await import('../src/config.js')

const run = randomUUID().slice(0, 8)
const emails: string[] = []
const address = (name: string) => {
  const email = `${name}-${run}@example.com`
  emails.push(email)
  return email
}
// A visitor of its own per call: TEST-NET addresses, never a real one.
let visitors = 0
const visitor = () => `198.51.100.${100 + ++visitors}`

function call(path: string, body?: unknown, method = 'POST') {
  return auth.handler(
    new Request(`${env.API_URL}/api/auth${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        origin: env.WEB_URL[0]!,
        'cf-connecting-ip': visitor(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

/** A person who signs in with mailed codes: no password. */
async function person(name: string) {
  const ctx = await auth.$context
  return ctx.internalAdapter.createUser({ email: address(name), name, emailVerified: true })
}

const codesFor = (email: string) =>
  prisma.verification.count({ where: { identifier: { endsWith: `-otp-${email}` } } })
const passwordOf = (userId: string) =>
  prisma.authAccount.count({ where: { userId, providerId: 'credential' } })

after(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } })
  await prisma.verification.deleteMany({ where: { identifier: { contains: run } } })
  await prisma.rateLimit.deleteMany({ where: { key: { startsWith: '198.51.100.' } } })
  await prisma.$disconnect()
})

test('asking for a reset makes no code, on every route that would', { skip }, async () => {
  const { email } = await person('victim')
  for (const path of ['/email-otp/request-password-reset', '/forget-password/email-otp']) {
    const response = await call(path, { email })
    assert.equal(response.status, 404, `${path}: ${await response.clone().text()}`)
  }
  for (const type of ['forget-password', 'email-verification']) {
    const response = await call('/email-otp/send-verification-otp', { email, type })
    assert.equal(response.status, 403, `${type}: ${await response.clone().text()}`)
  }
  assert.equal(await codesFor(email), 0)
})

test('no password is set on an account through a reset', { skip }, async () => {
  const victim = await person('target')
  const response = await call('/email-otp/reset-password', {
    email: victim.email,
    otp: '123456',
    password: 'mallory-chose-this-one',
  })
  assert.equal(response.status, 404)
  assert.equal(await passwordOf(victim.id), 0)
  const signIn = await call('/sign-in/email', {
    email: victim.email,
    password: 'mallory-chose-this-one',
  })
  assert.notEqual(signIn.status, 200)
})

test('the link and change routes are closed too', { skip }, async () => {
  for (const [path, body, method] of [
    ['/request-password-reset', { email: address('link') }, 'POST'],
    ['/reset-password', { newPassword: 'whatever-it-is-123', token: 'abc' }, 'POST'],
    ['/reset-password/abc?callbackURL=/', undefined, 'GET'],
    ['/change-password', { currentPassword: 'a-b-c-d-e-f', newPassword: 'g-h-i-j-k-l' }, 'POST'],
  ] as const) {
    const response = await call(path, body, method)
    assert.equal(response.status, 404, `${method} ${path}: ${await response.clone().text()}`)
  }
})

test('a sign-in code is still made and sent', { skip }, async () => {
  const { email } = await person('signs-in')
  const log = console.log
  console.log = () => {}
  try {
    const response = await call('/email-otp/send-verification-otp', { email, type: 'sign-in' })
    assert.equal(response.status, 200, await response.clone().text())
  } finally {
    console.log = log
  }
  assert.equal(await codesFor(email), 1)
})
