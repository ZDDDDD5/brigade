import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_FEATURES, FEATURES } from '@brigade/contracts'
import type { ConnectorContext } from '../src/connectors/types.js'

// The Google Ads App (src/connectors/google-ads.ts): reports are GAQL queries on a customer its
// owner picked, sent with Brigade's developer token and the manager it is reached through; writes
// are mutates; a customer not picked is refused before anything is sent.
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev-token'

const { googleAds, listAdsCustomers, metricsOf, dateClause, GOOGLE_ADS_VERSION } =
  await import('../src/connectors/google-ads.js')
const { GOOGLE_SCOPES } = await import('../src/connectors/google-oauth.js')
const { appCatalog, connectors } = await import('../src/connectors/index.js')

const API = `https://googleads.googleapis.com/${GOOGLE_ADS_VERSION}`
type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown }

const SETTINGS = {
  customers: [
    {
      id: '1234567890',
      loginCustomerId: '9998887776',
      name: 'Brigade',
      currency: 'EUR',
      timeZone: 'Europe/Paris',
    },
  ],
}

/** A context whose fetch answers from `routes` (first match by URL prefix) and records each call. */
function fake(routes: [string, (call: Call) => Response][], settings: unknown = SETTINGS) {
  const calls: Call[] = []
  const ctx = {
    callId: 'call-1',
    settings,
    fetch: async (url: string, init?: RequestInit) => {
      const call = {
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      }
      calls.push(call)
      const route = routes.find(([prefix]) => url.startsWith(prefix))
      if (!route) throw new Error(`unexpected ${url}`)
      return route[1](call)
    },
  } as unknown as ConnectorContext
  return { ctx, calls }
}

const ok = (body: unknown) => Response.json(body)
const op = (name: string) => googleAds.operations[name]!
const run = (name: string, ctx: ConnectorContext, input: unknown) =>
  op(name).run(ctx, op(name).input.parse(input))

test('Google Ads signs in on adwords, behind its feature, as a personal Marketing App', () => {
  assert.deepEqual(GOOGLE_SCOPES.google_ads, [
    'https://www.googleapis.com/auth/adwords',
    'https://www.googleapis.com/auth/userinfo.email',
  ])
  assert.equal(APP_FEATURES.google_ads, 'google_ads')
  assert.equal(FEATURES.google_ads.default, false)
  assert.equal(connectors.google_ads, googleAds)
  assert.equal(appCatalog.google_ads.personal, true)
  assert.equal(googleAds.auth, 'google')
})

test('reads and writes are declared as such', () => {
  const writes = Object.entries(googleAds.operations)
    .filter(([, o]) => o.write)
    .map(([name]) => name)
    .sort()
  assert.deepEqual(writes, [
    'google_ads_add_keywords',
    'google_ads_add_negative_keywords',
    'google_ads_create_responsive_search_ad',
    'google_ads_remove_keywords',
    'google_ads_remove_negative_keywords',
    'google_ads_set_campaign_budget',
    'google_ads_set_status',
  ])
})

test('the campaign report queries the picked customer through its manager, with the developer token', async () => {
  const { ctx, calls } = fake([
    [
      `${API}/customers/1234567890/googleAds:search`,
      () =>
        ok({
          results: [
            {
              campaign: {
                resourceName: 'customers/1234567890/campaigns/111',
                id: '111',
                name: 'Brand',
                status: 'ENABLED',
                advertisingChannelType: 'SEARCH',
                biddingStrategyType: 'MAXIMIZE_CLICKS',
              },
              campaignBudget: { amountMicros: '25000000' },
              // Google leaves out the metrics at zero.
              metrics: {
                impressions: '1200',
                clicks: '48',
                costMicros: '31415926',
                ctr: 0.04,
                averageCpc: 654498.4583,
              },
            },
          ],
          fieldMask: 'campaign.id,campaign.name',
        }),
    ],
  ])
  const result = await run('google_ads_campaigns', ctx, {
    customerId: '123-456-7890',
    during: 'LAST_7_DAYS',
  })
  assert.deepEqual(result, {
    campaigns: [
      {
        campaignId: '111',
        name: 'Brand',
        status: 'ENABLED',
        type: 'SEARCH',
        bidding: 'MAXIMIZE_CLICKS',
        dailyBudget: 25,
        impressions: 1200,
        clicks: 48,
        cost: 31.42,
        conversions: 0,
        conversionsValue: 0,
        ctr: 0.04,
        averageCpc: 0.65,
      },
    ],
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, 'POST')
  assert.equal(calls[0]!.headers['developer-token'], 'dev-token')
  assert.equal(calls[0]!.headers['login-customer-id'], '9998887776')
  const { query } = calls[0]!.body as { query: string }
  assert.match(
    query,
    /FROM campaign WHERE segments\.date DURING LAST_7_DAYS AND campaign\.status != 'REMOVED'/,
  )
  assert.match(query, /LIMIT 100$/)
})

test('a customer not picked is refused before anything is sent', async () => {
  const { ctx, calls } = fake([])
  const check = op('google_ads_campaigns').check!
  await assert.rejects(
    () => check(ctx, op('google_ads_campaigns').input.parse({ customerId: '1112223334' })),
    /111-222-3334 is not one of the Google Ads accounts picked/,
  )
  await assert.rejects(
    () => run('google_ads_keywords', fake([], null).ctx, { customerId: '1234567890' }),
    /No Google Ads account is picked for this connection yet/,
  )
  assert.equal(calls.length, 0)
})

test('IDs that go into a query are digits only, so no GAQL can be slipped in', () => {
  assert.throws(() =>
    op('google_ads_keywords').input.parse({
      customerId: '1234567890',
      campaignId: '1 OR campaign.id > 0',
    }),
  )
  assert.throws(() => op('google_ads_campaigns').input.parse({ customerId: '12345' }))
  assert.equal(
    dateClause({ during: 'LAST_30_DAYS', startDate: '2026-11-01', endDate: '2026-11-14' }),
    "segments.date BETWEEN '2026-11-01' AND '2026-11-14'",
  )
  assert.equal(dateClause({ during: 'YESTERDAY' }), 'segments.date DURING YESTERDAY')
})

test('a free GAQL query must be a SELECT', async () => {
  const { ctx } = fake([])
  const search = op('google_ads_search')
  assert.equal(
    await search.check!(
      ctx,
      search.input.parse({ customerId: '1234567890', query: 'SELECT campaign.id FROM campaign' }),
    ),
    null,
  )
  assert.equal(
    await search.check!(
      ctx,
      search.input.parse({ customerId: '1234567890', query: 'mutate campaigns please' }),
    ),
    'A GAQL query starts with SELECT',
  )
})

test('setting a budget finds the campaign’s budget and writes it in micros, rounded to the cent', async () => {
  const { ctx, calls } = fake([
    [
      `${API}/customers/1234567890/googleAds:search`,
      () =>
        ok({
          results: [
            {
              campaign: { id: '111', name: 'Brand' },
              campaignBudget: {
                resourceName: 'customers/1234567890/campaignBudgets/555',
                amountMicros: '10000000',
                referenceCount: '1',
              },
            },
          ],
        }),
    ],
    [
      `${API}/customers/1234567890/campaignBudgets:mutate`,
      () => ok({ results: [{ resourceName: 'customers/1234567890/campaignBudgets/555' }] }),
    ],
  ])
  const result = await run('google_ads_set_campaign_budget', ctx, {
    customerId: '1234567890',
    campaignId: '111',
    dailyBudget: 25.555,
  })
  assert.deepEqual(result, { campaign: 'Brand', before: 10, after: 25.56 })
  assert.deepEqual(calls[1]!.body, {
    operations: [
      {
        updateMask: 'amountMicros',
        update: {
          resourceName: 'customers/1234567890/campaignBudgets/555',
          amountMicros: '25560000',
        },
      },
    ],
  })
})

test('a budget shared by several campaigns is changed only when allowShared says so', async () => {
  const { ctx, calls } = fake([
    [
      `${API}/customers/1234567890/googleAds:search`,
      () =>
        ok({
          results: [
            {
              campaign: { id: '111', name: 'Brand' },
              campaignBudget: {
                resourceName: 'customers/1234567890/campaignBudgets/555',
                amountMicros: '10000000',
                explicitlyShared: true,
                referenceCount: '3',
              },
            },
          ],
        }),
    ],
  ])
  await assert.rejects(
    () =>
      run('google_ads_set_campaign_budget', ctx, {
        customerId: '1234567890',
        campaignId: '111',
        dailyBudget: 20,
      }),
    /shared by 3 campaigns/,
  )
  assert.equal(calls.length, 1)
})

test('pausing keywords updates their status by resource name', async () => {
  const { ctx, calls } = fake([
    [
      `${API}/customers/1234567890/adGroupCriteria:mutate`,
      () => ok({ results: [{ resourceName: 'customers/1234567890/adGroupCriteria/22~33' }] }),
    ],
  ])
  const input = { customerId: '1234567890', level: 'keyword', ids: ['22~33'], status: 'PAUSED' }
  assert.equal(
    await op('google_ads_set_status').check!(ctx, op('google_ads_set_status').input.parse(input)),
    null,
  )
  assert.deepEqual(await run('google_ads_set_status', ctx, input), {
    status: 'PAUSED',
    changed: ['customers/1234567890/adGroupCriteria/22~33'],
  })
  assert.deepEqual(calls[0]!.body, {
    operations: [
      {
        updateMask: 'status',
        update: { resourceName: 'customers/1234567890/adGroupCriteria/22~33', status: 'PAUSED' },
      },
    ],
  })
  // A keyword is its ad group and criterion; a campaign its ID alone.
  assert.match(
    (await op('google_ads_set_status').check!(
      ctx,
      op('google_ads_set_status').input.parse({ ...input, ids: ['33'] }),
    )) ?? '',
    /adGroupId~criterionId/,
  )
})

test('negative keywords go on the campaign as negative criteria', async () => {
  const { ctx, calls } = fake([
    [
      `${API}/customers/1234567890/campaignCriteria:mutate`,
      () => ok({ results: [{ resourceName: 'x' }] }),
    ],
  ])
  await run('google_ads_add_negative_keywords', ctx, {
    customerId: '1234567890',
    level: 'campaign',
    id: '111',
    keywords: [{ text: 'free', matchType: 'BROAD' }, { text: 'jobs' }],
  })
  assert.deepEqual(calls[0]!.body, {
    operations: [
      {
        create: {
          campaign: 'customers/1234567890/campaigns/111',
          negative: true,
          keyword: { text: 'free', matchType: 'BROAD' },
        },
      },
      {
        create: {
          campaign: 'customers/1234567890/campaigns/111',
          negative: true,
          keyword: { text: 'jobs', matchType: 'PHRASE' },
        },
      },
    ],
  })
})

test('a responsive search ad starts paused, with its headlines and descriptions', async () => {
  const { ctx, calls } = fake([
    [
      `${API}/customers/1234567890/adGroupAds:mutate`,
      () => ok({ results: [{ resourceName: 'customers/1234567890/adGroupAds/22~44' }] }),
    ],
  ])
  const result = await run('google_ads_create_responsive_search_ad', ctx, {
    customerId: '1234567890',
    adGroupId: '22',
    headlines: ['AI teammates', 'Ship faster', 'Try Brigade'],
    descriptions: ['Agents that do the work.', 'Start free today.'],
    finalUrl: 'https://www.brigade.lol/',
    path1: 'agents',
  })
  assert.deepEqual(result, { created: 'customers/1234567890/adGroupAds/22~44', status: 'PAUSED' })
  const body = calls[0]!.body as {
    operations: {
      create: { status: string; ad: { responsiveSearchAd: { headlines: unknown[] } } }
    }[]
  }
  assert.equal(body.operations[0]!.create.status, 'PAUSED')
  assert.deepEqual(body.operations[0]!.create.ad.responsiveSearchAd.headlines[0], {
    text: 'AI teammates',
  })
  assert.throws(() =>
    op('google_ads_create_responsive_search_ad').input.parse({
      customerId: '1234567890',
      adGroupId: '22',
      headlines: ['A headline far longer than thirty characters', 'b', 'c'],
      descriptions: ['d', 'e'],
      finalUrl: 'https://www.brigade.lol/',
    }),
  )
})

test("Google Ads' readable errors come out of its details, not its generic message", async () => {
  const { ctx } = fake([
    [
      `${API}/customers/1234567890/googleAds:search`,
      () =>
        Response.json(
          {
            error: {
              code: 403,
              message: 'The caller does not have permission',
              status: 'PERMISSION_DENIED',
              details: [
                {
                  '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure',
                  errors: [
                    {
                      errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' },
                      message: 'The developer token is only approved for use with test accounts.',
                    },
                  ],
                },
              ],
            },
          },
          { status: 403 },
        ),
    ],
  ])
  await assert.rejects(
    () => run('google_ads_campaigns', ctx, { customerId: '1234567890' }),
    /403: The developer token is only approved for use with test accounts\. \(DEVELOPER_TOKEN_NOT_APPROVED\)/,
  )
})

test('listing customers walks each accessible account, through its manager, without managers twice', async () => {
  const { ctx, calls } = fake([
    [
      `${API}/customers:listAccessibleCustomers`,
      () => ok({ resourceNames: ['customers/9998887776', 'customers/1234567890'] }),
    ],
    [
      `${API}/customers/9998887776/googleAds:search`,
      () =>
        ok({
          results: [
            {
              customerClient: {
                id: '9998887776',
                descriptiveName: 'Agency MCC',
                manager: true,
                level: '0',
                status: 'ENABLED',
              },
            },
            {
              customerClient: {
                id: '1234567890',
                descriptiveName: 'Brigade',
                manager: false,
                level: '1',
                currencyCode: 'EUR',
                timeZone: 'Europe/Paris',
                status: 'ENABLED',
              },
            },
            {
              customerClient: {
                id: '5556667778',
                descriptiveName: 'Askli',
                manager: false,
                level: '1',
                currencyCode: 'USD',
                timeZone: 'America/New_York',
                status: 'ENABLED',
              },
            },
          ],
        }),
    ],
    [
      `${API}/customers/1234567890/googleAds:search`,
      () =>
        ok({
          results: [
            {
              customerClient: {
                id: '1234567890',
                descriptiveName: 'Brigade',
                manager: false,
                level: '0',
                currencyCode: 'EUR',
                timeZone: 'Europe/Paris',
                status: 'ENABLED',
              },
            },
          ],
        }),
    ],
  ])
  const { customers, failed } = await listAdsCustomers(ctx.fetch)
  assert.deepEqual(failed, [])
  assert.deepEqual(
    customers.map((c) => [c.id, c.loginCustomerId, c.manager, c.managerName]),
    [
      ['9998887776', '9998887776', true, null],
      ['5556667778', '9998887776', false, 'Agency MCC'],
      // Reached directly as well: no manager needed.
      ['1234567890', '1234567890', false, null],
    ],
  )
  // listAccessibleCustomers takes no login-customer-id; each walk logs in as its own root.
  assert.equal(calls[0]!.headers['login-customer-id'], undefined)
  assert.equal(calls[0]!.headers['developer-token'], 'dev-token')
})

test('metrics left out by Google count as zero', () => {
  assert.deepEqual(metricsOf(), {
    impressions: 0,
    clicks: 0,
    cost: 0,
    conversions: 0,
    conversionsValue: 0,
    ctr: 0,
    averageCpc: 0,
  })
})
