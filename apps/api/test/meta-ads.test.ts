import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_FEATURES, FEATURES } from '@brigade/contracts'
import type { ConnectorContext } from '../src/connectors/types.js'

// The Meta Ads App (src/connectors/meta-ads.ts): reports read the Marketing API on an ad account
// its owner picked; writes first read which ad account the object belongs to, and refuse one that
// was not picked. The fixtures keep the shape of Meta's real replies (read on 15 Nov 2026 with a
// real account), with made-up names and IDs.
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')

const { metaAds, listMetaAdAccounts, metricsOf, fromMinor, toMinor } =
  await import('../src/connectors/meta-ads.js')
const { GRAPH, tokenRefused } = await import('../src/connectors/meta-oauth.js')
const { appCatalog, connectors } = await import('../src/connectors/index.js')
const { redact } = await import('../src/connectors/types.js')

type Call = { url: string; method: string; body?: URLSearchParams }

const SETTINGS = {
  accounts: [
    { id: 'act_111', name: 'Acme', currency: 'EUR', timeZone: 'Europe/Paris', business: 'Acme' },
  ],
}

/** GET me/adaccounts, as Meta answered it (names and IDs made up). */
const AD_ACCOUNTS = {
  data: [
    {
      id: 'act_222',
      name: 'Zeta Shop',
      currency: 'EUR',
      timezone_name: 'Europe/Paris',
      account_status: 1,
      business: { name: 'Zeta', id: '900' },
    },
    {
      id: 'act_111',
      name: 'Acme',
      currency: 'EUR',
      timezone_name: 'Europe/Paris',
      account_status: 1,
    },
    {
      id: 'act_333',
      name: 'Old',
      currency: 'JPY',
      timezone_name: 'Asia/Tokyo',
      account_status: 101,
    },
  ],
  paging: { cursors: { before: 'b', after: 'a' } },
}

/** A campaign with its insights expanded, as Meta answered it. */
const CAMPAIGN = {
  id: '6912491281097',
  name: 'Interest Targeting',
  status: 'PAUSED',
  effective_status: 'PAUSED',
  objective: 'OUTCOME_SALES',
  bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
  daily_budget: '6000',
  insights: {
    data: [
      {
        spend: '307.48',
        impressions: '7276',
        reach: '5581',
        frequency: '1.303709',
        clicks: '306',
        ctr: '4.205607',
        cpc: '1.004837',
        cpm: '42.259483',
        actions: [
          { action_type: 'link_click', value: '226' },
          { action_type: 'purchase', value: '1' },
        ],
        action_values: [{ action_type: 'purchase', value: '16.15' }],
        date_start: '2026-01-30',
        date_stop: '2026-11-16',
      },
    ],
  },
}

function fake(routes: [string, (call: Call) => Response][], settings: unknown = SETTINGS) {
  const calls: Call[] = []
  const ctx = {
    callId: 'call-1',
    settings,
    fetch: async (url: string, init?: RequestInit) => {
      const call = {
        url,
        method: init?.method ?? 'GET',
        body: init?.body instanceof URLSearchParams ? init.body : undefined,
      }
      calls.push(call)
      const route = routes.find(([prefix]) => url.startsWith(`${GRAPH}/${prefix}`))
      if (!route) throw new Error(`unexpected ${url}`)
      return route[1](call)
    },
  } as unknown as ConnectorContext
  return { ctx, calls }
}
const ok = (body: unknown) => Response.json(body)
const op = (name: string) => metaAds.operations[name]!
const run = (name: string, ctx: ConnectorContext, input: unknown) =>
  op(name).run(ctx, op(name).input.parse(input))

test('Meta Ads is a personal Marketing App on Meta sign-in, behind its feature', () => {
  assert.equal(APP_FEATURES.meta_ads, 'meta_ads')
  assert.equal(FEATURES.meta_ads.default, false)
  assert.equal(connectors.meta_ads, metaAds)
  assert.equal(appCatalog.meta_ads.personal, true)
  assert.equal(appCatalog.meta_ads.category, 'Marketing')
  assert.equal(metaAds.auth, 'meta')
})

test('only status and budget changes are writes', () => {
  const writes = Object.entries(metaAds.operations)
    .filter(([, o]) => o.write)
    .map(([name]) => name)
    .sort()
  assert.deepEqual(writes, ['meta_ads_set_budget', 'meta_ads_set_status'])
})

test('lists every ad account the user reaches, sorted, with its status in words', async () => {
  const { ctx, calls } = fake([['me/adaccounts', () => ok(AD_ACCOUNTS)]])
  const { accounts } = await listMetaAdAccounts(ctx.fetch)
  assert.deepEqual(
    accounts.map((a) => [a.id, a.name, a.business, a.status]),
    [
      ['act_111', 'Acme', null, 'ACTIVE'],
      ['act_333', 'Old', null, 'CLOSED'],
      ['act_222', 'Zeta Shop', 'Zeta', 'ACTIVE'],
    ],
  )
  // No `next` link: one page only.
  assert.equal(calls.length, 1)
})

test('campaigns read insights in the same call, money in the account currency', async () => {
  const { ctx, calls } = fake([['act_111/campaigns', () => ok({ data: [CAMPAIGN] })]])
  const result = (await run('meta_ads_campaigns', ctx, {
    accountId: '111',
    datePreset: 'last_7d',
  })) as { campaigns: Record<string, unknown>[] }
  const url = new URL(calls[0]!.url)
  assert.match(url.searchParams.get('fields')!, /insights\.date_preset\(last_7d\)\{spend,/)
  const c = result.campaigns[0]!
  assert.equal(c.dailyBudget, 60)
  assert.equal(c.spend, 307.48)
  assert.equal(c.impressions, 7276)
  assert.deepEqual(c.actions, { link_click: 226, purchase: 1 })
  assert.deepEqual(c.actionValues, { purchase: 16.15 })
})

test('a date range goes as time_range', async () => {
  const { ctx, calls } = fake([['act_111/insights', () => ok({ data: [] })]])
  await run('meta_ads_insights', ctx, {
    accountId: 'act_111',
    since: '2026-11-01',
    until: '2026-11-15',
    breakdowns: ['country'],
    timeIncrement: '1',
  })
  const params = new URL(calls[0]!.url).searchParams
  assert.equal(params.get('time_range'), '{"since":"2026-11-01","until":"2026-11-15"}')
  assert.equal(params.get('date_preset'), null)
  assert.equal(params.get('breakdowns'), 'country')
  assert.equal(params.get('time_increment'), '1')
})

test('an ad account not picked is refused before anything is sent', async () => {
  const { ctx, calls } = fake([])
  await assert.rejects(
    run('meta_ads_campaigns', ctx, { accountId: 'act_222' }),
    /not one of the ad accounts picked/,
  )
  const none = fake([], { accounts: [] })
  await assert.rejects(
    run('meta_ads_campaigns', none.ctx, { accountId: 'act_111' }),
    /No ad account/,
  )
  assert.equal(calls.length + none.calls.length, 0)
})

test('a write on an object of another ad account is refused, and nothing is changed', async () => {
  const { ctx, calls } = fake([
    ['555', () => ok({ id: '555', account_id: '222', status: 'ACTIVE' })],
  ])
  await assert.rejects(
    run('meta_ads_set_status', ctx, { id: '555', status: 'PAUSED' }),
    /act_222 is not one of the ad accounts picked/,
  )
  assert.ok(calls.every((c) => c.method === 'GET'))
})

test('pausing reads the owner, then posts the status', async () => {
  const { ctx, calls } = fake([
    [
      '555',
      (call) =>
        call.method === 'POST'
          ? ok({ success: true })
          : ok({ id: '555', account_id: '111', name: 'Retarget', status: 'ACTIVE' }),
    ],
  ])
  const result = await run('meta_ads_set_status', ctx, { id: '555', status: 'PAUSED' })
  assert.deepEqual(result, {
    id: '555',
    name: 'Retarget',
    accountId: 'act_111',
    before: 'ACTIVE',
    status: 'PAUSED',
  })
  const write = calls.find((c) => c.method === 'POST')!
  assert.equal(write.body!.get('status'), 'PAUSED')
})

test('a budget changes the kind the object has, in minor units', async () => {
  const { ctx, calls } = fake([
    [
      '777',
      (call) =>
        call.method === 'POST'
          ? ok({ success: true })
          : ok({ id: '777', account_id: '111', name: 'Prospecting', lifetime_budget: '50000' }),
    ],
  ])
  const result = (await run('meta_ads_set_budget', ctx, { id: '777', amount: 750.5 })) as Record<
    string,
    unknown
  >
  assert.equal(result.budget, 'lifetime')
  assert.equal(result.before, 500)
  assert.equal(calls.find((c) => c.method === 'POST')!.body!.get('lifetime_budget'), '75050')
})

test('an ad set under a campaign budget has none of its own to change', async () => {
  const { ctx } = fake([['888', () => ok({ id: '888', account_id: '111', daily_budget: '0' })]])
  await assert.rejects(
    run('meta_ads_set_budget', ctx, { id: '888', amount: 10 }),
    /no budget of its own/,
  )
})

test('whole-unit currencies are not divided by 100', () => {
  assert.equal(fromMinor('5000', 'JPY'), 5000)
  assert.equal(fromMinor('5000', 'EUR'), 50)
  assert.equal(toMinor(12.34, 'USD'), 1234)
  assert.equal(toMinor(1200, 'KRW'), 1200)
  assert.equal(fromMinor(undefined, 'EUR'), null)
})

test('metrics come as numbers, missing ones as zero', () => {
  assert.deepEqual(metricsOf({}), {
    spend: 0,
    impressions: 0,
    reach: 0,
    frequency: 0,
    clicks: 0,
    ctr: 0,
    cpc: 0,
    cpm: 0,
    actions: {},
    actionValues: {},
  })
})

test('Graph errors read as Meta wrote them; an expired token asks for a reconnect', async () => {
  const { ctx } = fake([
    [
      'act_111/campaigns',
      () =>
        Response.json(
          {
            error: {
              message: 'Error validating access token: Session has expired',
              type: 'OAuthException',
              code: 190,
              error_subcode: 463,
            },
          },
          { status: 400 },
        ),
    ],
  ])
  await assert.rejects(
    run('meta_ads_campaigns', ctx, { accountId: 'act_111' }),
    /400: Error validating access token: Session has expired \(code 190\/463\)/,
  )
  assert.equal(tokenRefused(400, { error: { code: 190 } }), true)
  assert.equal(tokenRefused(400, { error: { code: 100 } }), false)
  assert.equal(tokenRefused(401, null), true)
})

test('Meta tokens never leave the API in an error', () => {
  assert.equal(
    redact('bad token EAAQlbZBZCqZC0kBO1234567890abcdefghijklmnopqrstu'),
    'bad token [redacted token]',
  )
})

test('reports read on page by page: the cursor goes back, and the last page says so', async () => {
  const { ctx, calls } = fake([
    [
      'act_111/insights',
      (call) =>
        new URL(call.url).searchParams.get('after') === 'c2'
          ? ok({ data: [{ spend: '2' }], paging: { cursors: { before: 'c1', after: 'c3' } } })
          : ok({
              data: [{ spend: '1' }],
              paging: {
                cursors: { before: 'c0', after: 'c2' },
                next: `${GRAPH}/act_111/insights?after=c2`,
              },
            }),
    ],
  ])
  const first = (await run('meta_ads_insights', ctx, {
    accountId: 'act_111',
    timeIncrement: '1',
    limit: 1,
  })) as { next: string | null; rows: unknown[] }
  assert.equal(first.next, 'c2')
  const second = (await run('meta_ads_insights', ctx, {
    accountId: 'act_111',
    timeIncrement: '1',
    limit: 1,
    after: first.next,
  })) as { next: string | null; rows: unknown[] }
  assert.equal(second.next, null)
  assert.equal(new URL(calls[1]!.url).searchParams.get('after'), 'c2')
  assert.equal(second.rows.length, 1)
})

test('listings carry the cursor too', async () => {
  const { ctx } = fake([
    [
      'act_111/campaigns',
      () =>
        ok({
          data: [CAMPAIGN],
          paging: { cursors: { after: 'n1' }, next: `${GRAPH}/act_111/campaigns?after=n1` },
        }),
    ],
  ])
  const result = (await run('meta_ads_campaigns', ctx, { accountId: 'act_111', limit: 1 })) as {
    next: string | null
  }
  assert.equal(result.next, 'n1')
})
