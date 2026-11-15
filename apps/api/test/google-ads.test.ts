import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import pg from 'pg'

// Google Ads' conversions (src/google-ads.ts): the settings checked, a conversion kept once
// and only for a person who came from a Google ad, and the job's sends to Google's Data
// Manager API (a stub of fetch here): what is sent, a refused event given up, any other failure
// kept for the next run. The parts on the database skip without one to reach.
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
process.env.POSTHOG_KEY = ''

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "userId" from "AdConversion" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const ads = await import('../src/google-ads.js')
const { parseSignupSource, signupProperties } = await import('../src/signup-source.js')
const { prisma } = await import('../src/db.js')

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const serviceAccount = JSON.stringify({
  client_email: 'conversions@brigade-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
})
const settings = {
  GOOGLE_ADS_CUSTOMER_ID: '123-456-7890',
  GOOGLE_ADS_SIGNUP_ACTION_ID: '111',
  GOOGLE_ADS_SUBSCRIPTION_ACTION_ID: '222',
  GOOGLE_ADS_SERVICE_ACCOUNT: serviceAccount,
}

test('the settings: all needed, Google ids checked, dashes dropped', () => {
  assert.equal(ads.adsConfig({}), null)
  assert.equal(ads.adsConfig({ ...settings, GOOGLE_ADS_SERVICE_ACCOUNT: undefined }), null)
  assert.equal(ads.adsConfig({ ...settings, GOOGLE_ADS_CUSTOMER_ID: '12345' }), null)
  assert.equal(ads.adsConfig({ ...settings, GOOGLE_ADS_SIGNUP_ACTION_ID: 'signup' }), null)
  assert.equal(ads.adsConfig({ ...settings, GOOGLE_ADS_SERVICE_ACCOUNT: '{not json' }), null)
  assert.equal(ads.adsConfig({ ...settings, GOOGLE_ADS_LOGIN_CUSTOMER_ID: '1' }), null)
  const config = ads.adsConfig({ ...settings, GOOGLE_ADS_LOGIN_CUSTOMER_ID: '999-888-7777' })
  assert.equal(config?.customerId, '1234567890')
  assert.equal(config?.loginCustomerId, '9998887777')
  assert.deepEqual(config?.actions, { sign_up: '111', subscription: '222' })
})

test("a Google ad's click ids make the channel google_ads, are checked, and stay off PostHog", () => {
  const source = parseSignupSource({
    utm_source: 'newsletter',
    ref: 'google.com',
    gclid: 'Cj0KCQ-x_1',
    wbraid: 'bad id<script>',
  })
  assert.equal(source.channel, 'google_ads')
  assert.deepEqual(source.adClick, { gclid: 'Cj0KCQ-x_1' })
  assert.ok(!JSON.stringify(signupProperties(source, 'email_code')).includes('Cj0KCQ'))
  assert.equal(parseSignupSource({ utm_source: 'google', utm_medium: 'cpc' }).channel, 'google_ads')
  assert.equal(parseSignupSource({ gclid: 'x'.repeat(201) }).adClick, undefined)
  assert.equal(ads.adClickOf({ channel: 'direct' }), null)
  assert.deepEqual(ads.adClickOf({ adClick: { gbraid: 'g1', other: 'x' } }), { gbraid: 'g1' })
})

test("the request's body: the account, the conversion action, the click and the price", () => {
  const config = ads.adsConfig({ ...settings, GOOGLE_ADS_LOGIN_CUSTOMER_ID: '9998887777' })!
  const at = new Date('2026-11-15T10:00:00Z')
  assert.deepEqual(
    ads.ingestBody(
      config,
      {
        id: 'row1',
        kind: 'subscription',
        at,
        value: 99,
        currency: 'EUR',
        user: { attribution: null },
      },
      { gclid: 'g' },
    ),
    {
      destinations: [
        {
          operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1234567890' },
          loginAccount: { accountType: 'GOOGLE_ADS', accountId: '9998887777' },
          productDestinationId: '222',
        },
      ],
      events: [
        {
          adIdentifiers: { gclid: 'g' },
          eventTimestamp: '2026-11-15T10:00:00.000Z',
          transactionId: 'row1',
          eventSource: 'WEB',
          conversionValue: 99,
          currency: 'EUR',
        },
      ],
    },
  )
})

// ---------------------------------------------------------------------------
// Against the database, with Google stubbed

const run = randomUUID().slice(0, 8)
const userIds: string[] = []
after(async () => {
  if (!skip) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.$disconnect()
})

async function makeUser(attribution: object | null) {
  const user = await prisma.user.create({
    data: {
      id: `ads-${run}-${userIds.length}`,
      email: `ads-${run}-${userIds.length}@example.com`,
      name: 'Ada',
      ...(attribution && { attribution }),
    },
  })
  userIds.push(user.id)
  return user
}

type Call = { url: string; body: string; headers: Record<string, string> }

/** Google, stubbed: the token endpoint, and the ingest's answers in turn (200 after them). */
function stubGoogle(answers: number[]) {
  const calls: Call[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = String(init?.body ?? '')
    calls.push({ url, body, headers: Object.fromEntries(new Headers(init?.headers)) })
    if (url.startsWith('https://oauth2.googleapis.com/token'))
      return Response.json({ access_token: 'token-1', expires_in: 3600 })
    const status = answers.shift() ?? 200
    return new Response(status === 200 ? '{}' : '{"error":{"message":"no"}}', { status })
  }) as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = real) }
}

const ingests = (calls: Call[]) => calls.filter((c) => c.url.includes('datamanager'))

test('a conversion is kept once per kind, and only for a Google ad', { skip }, async () => {
  const fromAd = await makeUser({ channel: 'google_ads', adClick: { gclid: 'g-once' } })
  const organic = await makeUser({ channel: 'google_organic' })
  await ads.recordAdConversion(fromAd.id, 'sign_up')
  await ads.recordAdConversion(fromAd.id, 'sign_up')
  await ads.recordAdConversion(fromAd.id, 'subscription', { value: 99, currency: 'eur' })
  await ads.recordAdConversion(organic.id, 'sign_up')
  const rows = await prisma.adConversion.findMany({
    where: { userId: { in: [fromAd.id, organic.id] } },
    orderBy: { kind: 'asc' },
  })
  assert.deepEqual(
    rows.map((r) => [r.userId, r.kind, r.value, r.currency]),
    [
      [fromAd.id, 'sign_up', null, null],
      [fromAd.id, 'subscription', 99, 'EUR'],
    ],
  )
})

test(
  'the job sends with a signed token, gives up a refused event, keeps the rest for later',
  { skip },
  async () => {
    await prisma.adConversion.deleteMany({})
    ads.forgetAdsToken()
    const config = ads.adsConfig(settings)!
    const now = new Date()

    // Nothing without the settings.
    const off = stubGoogle([])
    const first = await makeUser({ adClick: { gclid: 'g-first' } })
    await ads.recordAdConversion(first.id, 'sign_up', { at: new Date(now.getTime() - 60_000) })
    assert.deepEqual(await ads.sendAdConversions(now, null), { sent: 0, failed: 0 })
    off.restore()
    assert.equal(off.calls.length, 0)

    const refused = await makeUser({ adClick: { gclid: 'g-refused' } })
    await ads.recordAdConversion(refused.id, 'sign_up', { at: new Date(now.getTime() - 50_000) })
    const later = await makeUser({ adClick: { wbraid: 'w-later' } })
    await ads.recordAdConversion(later.id, 'sign_up', { at: new Date(now.getTime() - 40_000) })
    const waiting = await makeUser({ adClick: { gclid: 'g-waiting' } })
    await ads.recordAdConversion(waiting.id, 'sign_up', { at: new Date(now.getTime() - 30_000) })
    const old = await makeUser({ adClick: { gclid: 'g-old' } })
    await ads.recordAdConversion(old.id, 'subscription', {
      at: new Date(now.getTime() - 91 * 24 * 60 * 60_000),
    })

    // first: taken; refused: 400; later: 503, which stops the run before waiting.
    const google = stubGoogle([200, 400, 503])
    try {
      const result = await ads.sendAdConversions(now, config)
      assert.deepEqual(result, { sent: 1, failed: 2 })
    } finally {
      google.restore()
    }
    const token = google.calls.find((c) => c.url.includes('oauth2'))!
    const assertion = new URLSearchParams(token.body).get('assertion')!
    const [header, claims, signature] = assertion.split('.')
    assert.ok(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature!, 'base64url'),
      ),
      "the token's request is signed with the service account's key",
    )
    const claimed = JSON.parse(Buffer.from(claims!, 'base64url').toString())
    assert.equal(claimed.scope, 'https://www.googleapis.com/auth/datamanager')
    assert.equal(claimed.iss, 'conversions@brigade-test.iam.gserviceaccount.com')

    const sent = ingests(google.calls)
    assert.equal(sent.length, 3, 'the run stops at the 503')
    assert.equal(sent[0]!.headers.authorization, 'Bearer token-1')
    const body = JSON.parse(sent[0]!.body)
    assert.equal(body.destinations[0].productDestinationId, '111')
    assert.deepEqual(body.events[0].adIdentifiers, { gclid: 'g-first' })
    assert.deepEqual(JSON.parse(sent[2]!.body).events[0].adIdentifiers, { wbraid: 'w-later' })
    assert.ok(!google.calls.some((c) => c.body.includes('@example.com')), 'no email address')

    const state = async (userId: string) =>
      prisma.adConversion.findFirstOrThrow({ where: { userId } })
    assert.ok((await state(first.id)).sentAt, 'taken')
    const refusedRow = await state(refused.id)
    assert.ok(refusedRow.failedAt && refusedRow.error?.includes('400'), 'refused: given up')
    const laterRow = await state(later.id)
    assert.equal(laterRow.failedAt, null, 'Google down: tried again')
    assert.equal(laterRow.attempts, 1)
    assert.equal((await state(waiting.id)).attempts, 0, 'not tried after the stop')
    assert.equal((await state(old.id)).error, 'older than 90 days')

    // The next run sends what waited, and nothing twice.
    const again = stubGoogle([])
    try {
      assert.deepEqual(await ads.sendAdConversions(new Date(), config), { sent: 2, failed: 0 })
    } finally {
      again.restore()
    }
    assert.deepEqual(
      ingests(again.calls).map((c) => JSON.parse(c.body).events[0].adIdentifiers),
      [{ wbraid: 'w-later' }, { gclid: 'g-waiting' }],
    )
  },
)
