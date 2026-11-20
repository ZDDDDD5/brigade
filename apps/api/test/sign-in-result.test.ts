import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { Hono } from 'hono'
import { sessionStub } from './session-stub.js'

// A sign-in's result, read by the page that started it (GET /connections/sign-in/:attempt), so
// that a ticket waiting on a sign-in is answered even when the sign-in tab's own word never
// reaches it (in Brigade.app, a brigade:// link the browser did not open). Only the person who
// started it reads it, and only once the provider sent them back. Runs against the API's
// development database (apps/api/.env), skipped when none answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.GOOGLE_CLIENT_ID ??= 'test-google-client'
process.env.GOOGLE_CLIENT_SECRET ??= 'test-google-secret'

const { prisma } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

describe(
  'a sign-in’s result for the page that started it',
  { skip: !database && 'no database answers' },
  () => {
    const suffix = randomUUID().slice(0, 8)
    const org = `org-sign-in-${suffix}`
    const ids = {} as Record<'workspace' | 'ada' | 'bob', string>
    let app: Hono
    let restore: () => void

    before(async () => {
      await prisma.organization.create({ data: { id: org, name: 'Sign-in', slug: org } })
      ids.workspace = (
        await prisma.workspace.create({ data: { organizationId: org, name: 'Sign-in' } })
      ).id
      for (const who of ['ada', 'bob'] as const) {
        ids[who] = `${who}-${suffix}`
        await prisma.user.create({
          data: { id: ids[who], name: who, email: `${who}-${suffix}@example.test` },
        })
        await prisma.member.create({
          data: { id: `m-${ids[who]}`, organizationId: org, userId: ids[who], role: 'owner' },
        })
      }
      const { auth } = await import('../src/auth.js')
      const { connections } = await import('../src/routes/connections.js')
      const getSession = auth.api.getSession
      ;(auth.api as { getSession: unknown }).getSession = sessionStub((headers) => ({
        user: { id: headers.get('x-test-user') },
        session: {
          id: `session-${headers.get('x-test-user')}`,
          activeOrganizationId: org,
          activeWorkspaceId: ids.workspace,
        },
      }))
      restore = () => ((auth.api as { getSession: unknown }).getSession = getSession)
      app = new Hono().route('/api/connections', connections)
    })

    after(async () => {
      restore?.()
      if (ids.workspace) await prisma.workspace.deleteMany({ where: { id: ids.workspace } })
      await prisma.member.deleteMany({ where: { organizationId: org } })
      await prisma.organization.deleteMany({ where: { id: org } })
      await prisma.user.deleteMany({ where: { id: { in: [ids.ada, ids.bob] } } })
    })

    const get = (who: 'ada' | 'bob', path: string) =>
      app.request(path, { headers: { 'x-test-user': ids[who] } })

    test('it says nothing until the provider sends the person back, then only to them', async () => {
      const started = await app.request('/api/connections/google', {
        method: 'POST',
        headers: { 'x-test-user': ids.ada, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'google_docs', returnTo: '/app/connections?popup=1' }),
      })
      assert.equal(started.status, 200, await started.clone().text())
      const { url, attempt } = (await started.json()) as { url: string; attempt: string }
      assert.ok(attempt)
      const state = new URL(url).searchParams.get('state')!

      const result = async (who: 'ada' | 'bob') =>
        (await get(who, `/api/connections/sign-in/${attempt}`)).json()
      assert.deepEqual(await result('ada'), {}, 'still going on')

      // Declined at Google: no code to exchange, so nothing outside is called.
      const back = await get(
        'ada',
        `/api/connections/oauth/google/callback?state=${state}&error=access_denied`,
      )
      assert.equal(back.status, 302)
      assert.match(back.headers.get('location') ?? '', /error=declined/)

      assert.deepEqual(await result('ada'), { error: 'declined' })
      assert.deepEqual(await result('bob'), {}, 'another person reads nothing of it')
      assert.deepEqual(
        await (await get('ada', '/api/connections/sign-in/not-an-attempt')).json(),
        {},
      )
    })
  },
)
