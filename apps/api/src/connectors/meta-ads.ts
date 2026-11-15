// Meta Ads connector (Marketing API, on the Graph API), on the account's Meta user token in the
// vault. One Brigade account is one Facebook sign-in on Brigade's Meta app; its owner then picks
// the ad accounts teammates reach (Connection.settings). Reports read Insights; writes change a
// campaign's, ad set's or ad's status, or a budget, each after checking that the object belongs to
// a picked ad account.
import { z } from 'zod'
import { GRAPH } from './meta-oauth.js'
import {
  ConnectorError,
  op,
  redact,
  type ConnectorContext,
  type ConnectorDefinition,
} from './types.js'

/** An ad account its owner picked. */
export const MetaAdAccount = z.object({
  id: z.string().regex(/^act_\d{1,20}$/),
  name: z.string().nullable(),
  currency: z.string().optional(),
  timeZone: z.string().optional(),
  business: z.string().nullable().optional(),
})
export type MetaAdAccount = z.infer<typeof MetaAdAccount>
export const MetaAdsSettings = z.object({ accounts: z.array(MetaAdAccount).max(50) })

/** The picked ad accounts of an account, from its settings. */
export const pickedAdAccounts = (settings: unknown): MetaAdAccount[] => {
  const parsed = MetaAdsSettings.safeParse(settings)
  return parsed.success ? parsed.data.accounts : []
}

/** Meta's account_status codes, as words. */
const ACCOUNT_STATUS: Record<number, string> = {
  1: 'ACTIVE',
  2: 'DISABLED',
  3: 'UNSETTLED',
  7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD',
  100: 'PENDING_CLOSURE',
  101: 'CLOSED',
  201: 'ANY_ACTIVE',
  202: 'ANY_CLOSED',
}

/**
 * Currencies Meta counts in whole units rather than hundredths (its "currency offset" of 1):
 * budgets in them are not divided by 100.
 */
const WHOLE_UNIT_CURRENCIES = new Set([
  'CLP',
  'COP',
  'CRC',
  'HUF',
  'ISK',
  'IDR',
  'JPY',
  'KRW',
  'PYG',
  'TWD',
  'VND',
])
const offset = (currency?: string) => (currency && WHOLE_UNIT_CURRENCIES.has(currency) ? 1 : 100)
/** A budget as Meta keeps it (a string in the currency's smallest unit), as an amount. */
export const fromMinor = (value: unknown, currency?: string) =>
  value === undefined || value === null || value === '' ? null : Number(value) / offset(currency)
/** An amount as Meta wants a budget: a whole number in the currency's smallest unit. */
export const toMinor = (amount: number, currency?: string) => Math.round(amount * offset(currency))

/** Graph API errors: the readable message, and the one Meta writes for people when it has one. */
export async function graphJson<T>(response: Response): Promise<T> {
  const body = await response.text()
  if (!response.ok) {
    let message = body.slice(0, 500)
    try {
      const parsed = JSON.parse(body) as {
        error?: {
          message?: string
          error_user_title?: string
          error_user_msg?: string
          code?: number
          error_subcode?: number
        }
      }
      const e = parsed.error
      if (e)
        message = [
          e.error_user_msg ?? e.message,
          e.code ? `(code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : '',
        ]
          .filter(Boolean)
          .join(' ')
    } catch {
      // not JSON
    }
    throw new ConnectorError(redact(`${response.status}: ${message}`), response.status)
  }
  return (body ? JSON.parse(body) : {}) as T
}

// biome-ignore lint: Graph API objects are untyped JSON, shaped by the fields asked for
type Row = Record<string, any>

const get = async <T = Row>(
  fetch: ConnectorContext['fetch'],
  path: string,
  params: Record<string, string> = {},
) => graphJson<T>(await fetch(`${GRAPH}/${path}?${new URLSearchParams(params)}`))

const post = async <T = Row>(
  fetch: ConnectorContext['fetch'],
  path: string,
  params: Record<string, string>,
) =>
  graphJson<T>(
    await fetch(`${GRAPH}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    }),
  )

/** Every ad account the signed-in Facebook user reaches, directly or through a business. */
export async function listMetaAdAccounts(fetch: ConnectorContext['fetch']) {
  const accounts: (MetaAdAccount & { status: string })[] = []
  let after: string | undefined
  // Pages of 100, at most 5: an agency user may reach hundreds.
  for (let page = 0; page < 5; page++) {
    const result = await get<{
      data?: Row[]
      paging?: { cursors?: { after?: string }; next?: string }
    }>(fetch, 'me/adaccounts', {
      fields: 'id,name,currency,timezone_name,account_status,business{name}',
      limit: '100',
      ...(after ? { after } : {}),
    })
    for (const a of result.data ?? []) {
      if (typeof a.id !== 'string' || !/^act_\d{1,20}$/.test(a.id)) continue
      accounts.push({
        id: a.id,
        name: a.name ?? null,
        ...(a.currency ? { currency: a.currency } : {}),
        ...(a.timezone_name ? { timeZone: a.timezone_name } : {}),
        business: a.business?.name ?? null,
        status: ACCOUNT_STATUS[a.account_status as number] ?? String(a.account_status ?? 'UNKNOWN'),
      })
    }
    after = result.paging?.next ? result.paging.cursors?.after : undefined
    if (!after) break
  }
  return { accounts: accounts.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)) }
}

const accountId = z
  .string()
  .trim()
  .transform((v) => (v.startsWith('act_') ? v : `act_${v}`))
  .pipe(z.string().regex(/^act_\d{1,20}$/, 'An ad account ID, e.g. act_1234567890'))
  .describe('The ad account, e.g. act_1234567890 (meta_ads_list_accounts lists them)')
const objectId = (what: string) =>
  z
    .string()
    .regex(/^\d{1,25}$/, `A ${what} ID: digits only`)
    .describe(`The ${what} ID (digits)`)

/** The ad account a call names, if its owner picked it; else why not. */
function adAccountOf(ctx: Pick<ConnectorContext, 'settings'>, id: string) {
  const picked = pickedAdAccounts(ctx.settings)
  const account = picked.find((a) => a.id === id)
  if (account) return account
  throw new ConnectorError(
    picked.length
      ? `${id} is not one of the ad accounts picked for this connection (${picked.map((a) => a.id).join(', ')}). Its owner picks them in Apps › Meta Ads.`
      : 'No ad account is picked for this connection yet: its owner picks them in Apps › Meta Ads, after signing in.',
  )
}
const check = async (ctx: ConnectorContext, i: { accountId: string }) => {
  adAccountOf(ctx, i.accountId)
  return null
}

/**
 * The picked ad account a campaign, ad set or ad belongs to, read from Meta: a teammate cannot
 * reach an object of another account by naming its ID.
 */
async function ownerOf(ctx: ConnectorContext, id: string, fields = '') {
  const object = await get(ctx.fetch, id, {
    fields: ['account_id', fields].filter(Boolean).join(','),
  })
  if (!object.account_id) throw new ConnectorError(`${id} is not a campaign, ad set or ad`)
  return { object, account: adAccountOf(ctx, `act_${object.account_id}`) }
}

const PRESETS = [
  'today',
  'yesterday',
  'last_7d',
  'last_14d',
  'last_30d',
  'last_90d',
  'this_month',
  'last_month',
  'this_year',
  'maximum',
] as const
const dates = {
  datePreset: z
    .enum(PRESETS)
    .default('last_30d')
    .describe(
      "A range ending today, in the ad account's time zone. Ignored when since and until are given",
    ),
  since: z.iso.date().optional().describe("YYYY-MM-DD, in the ad account's time zone"),
  until: z.iso.date().optional().describe('YYYY-MM-DD, inclusive'),
}
type DateInput = { datePreset: string; since?: string | undefined; until?: string | undefined }
/** The range as Insights takes it: one of its parameters. */
const range = (i: DateInput): Record<string, string> =>
  i.since && i.until
    ? { time_range: JSON.stringify({ since: i.since, until: i.until }) }
    : { date_preset: i.datePreset }
/** The same range as a field expansion: insights.date_preset(last_30d){…}. */
const rangeModifier = (i: DateInput) =>
  i.since && i.until
    ? `.time_range(${JSON.stringify({ since: i.since, until: i.until })})`
    : `.date_preset(${i.datePreset})`
const dateLabel = (i: DateInput) =>
  i.since && i.until ? `${i.since} to ${i.until}` : i.datePreset.replaceAll('_', ' ')
const limit = z.number().int().min(1).max(500).default(100).describe('Rows at most')

const METRICS = 'spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,action_values'

/** Actions (link_click, purchase, lead…) as { type: count }, Meta's strings as numbers. */
const byType = (list: unknown) =>
  Array.isArray(list)
    ? Object.fromEntries(
        list
          .filter((a) => a && typeof a.action_type === 'string')
          .map((a) => [a.action_type as string, Number(a.value ?? 0)]),
      )
    : {}
const num = (v: unknown) => (v === undefined || v === null || v === '' ? 0 : Number(v))
/** A row's metrics as numbers; Meta leaves out a row with no delivery. */
export const metricsOf = (m: Row = {}) => ({
  spend: num(m.spend),
  impressions: num(m.impressions),
  reach: num(m.reach),
  frequency: Math.round(num(m.frequency) * 100) / 100,
  clicks: num(m.clicks),
  ctr: Math.round(num(m.ctr) * 100) / 100,
  cpc: Math.round(num(m.cpc) * 100) / 100,
  cpm: Math.round(num(m.cpm) * 100) / 100,
  actions: byType(m.actions),
  actionValues: byType(m.action_values),
})
const insightsOf = (row: Row) => metricsOf(row.insights?.data?.[0])

const statusFilter = (activeOnly: boolean): Record<string, string> =>
  activeOnly ? { effective_status: JSON.stringify(['ACTIVE']) } : {}

export const metaAds: ConnectorDefinition = {
  kind: 'meta_ads',
  label: 'Meta Ads',
  auth: 'meta',
  operations: {
    meta_ads_list_accounts: op({
      description:
        "The Meta ad accounts this connection reaches (picked by its owner), with each one's currency, time zone and business. Every other tool names one by its accountId (act_…).",
      write: false,
      input: z.object({}),
      target: () => 'ad account list',
      run: async (ctx) => ({
        accounts: pickedAdAccounts(ctx.settings).map((a) => ({
          accountId: a.id,
          name: a.name,
          currency: a.currency,
          timeZone: a.timeZone,
          business: a.business ?? null,
        })),
      }),
    }),
    meta_ads_campaigns: op({
      description:
        'Campaigns of an ad account with their status, objective, bid strategy, budget and performance over a date range (spend, impressions, reach, clicks, CTR, CPC, CPM, actions such as purchases or leads). Money is in the account currency.',
      write: false,
      input: z.object({
        accountId,
        ...dates,
        activeOnly: z.boolean().default(false).describe('Only campaigns delivering now'),
        limit,
      }),
      target: (i) => `campaigns of ${i.accountId}, ${dateLabel(i)}`,
      check,
      run: async (ctx, i) => {
        const account = adAccountOf(ctx, i.accountId)
        const { data = [] } = await get<{ data?: Row[] }>(ctx.fetch, `${account.id}/campaigns`, {
          fields: `id,name,status,effective_status,objective,bid_strategy,daily_budget,lifetime_budget,start_time,stop_time,insights${rangeModifier(i)}{${METRICS}}`,
          limit: String(i.limit),
          ...statusFilter(i.activeOnly),
        })
        return {
          currency: account.currency,
          campaigns: data.map((c) => ({
            campaignId: c.id,
            name: c.name,
            status: c.status,
            effectiveStatus: c.effective_status,
            objective: c.objective,
            bidStrategy: c.bid_strategy ?? null,
            dailyBudget: fromMinor(c.daily_budget, account.currency),
            lifetimeBudget: fromMinor(c.lifetime_budget, account.currency),
            startTime: c.start_time ?? null,
            stopTime: c.stop_time ?? null,
            ...insightsOf(c),
          })),
        }
      },
    }),
    meta_ads_ad_sets: op({
      description:
        'Ad sets of an ad account (or of one campaign) with their status, optimization goal, billing event, budget, targeting summary and performance over a date range.',
      write: false,
      input: z.object({
        accountId,
        campaignId: objectId('campaign').optional(),
        ...dates,
        activeOnly: z.boolean().default(false),
        limit,
      }),
      target: (i) =>
        `ad sets${i.campaignId ? ` of campaign ${i.campaignId}` : ''} in ${i.accountId}, ${dateLabel(i)}`,
      check,
      run: async (ctx, i) => {
        const account = adAccountOf(ctx, i.accountId)
        if (i.campaignId) {
          const { account: owner } = await ownerOf(ctx, i.campaignId)
          if (owner.id !== account.id)
            throw new ConnectorError(`Campaign ${i.campaignId} is not in ${account.id}`)
        }
        const { data = [] } = await get<{ data?: Row[] }>(
          ctx.fetch,
          i.campaignId ? `${i.campaignId}/adsets` : `${account.id}/adsets`,
          {
            fields: `id,name,campaign_id,status,effective_status,optimization_goal,billing_event,bid_amount,daily_budget,lifetime_budget,targeting{age_min,age_max,genders,geo_locations},insights${rangeModifier(i)}{${METRICS}}`,
            limit: String(i.limit),
            ...statusFilter(i.activeOnly),
          },
        )
        return {
          currency: account.currency,
          adSets: data.map((s) => ({
            adSetId: s.id,
            name: s.name,
            campaignId: s.campaign_id,
            status: s.status,
            effectiveStatus: s.effective_status,
            optimizationGoal: s.optimization_goal,
            billingEvent: s.billing_event,
            bidAmount: fromMinor(s.bid_amount, account.currency),
            dailyBudget: fromMinor(s.daily_budget, account.currency),
            lifetimeBudget: fromMinor(s.lifetime_budget, account.currency),
            targeting: s.targeting ?? null,
            ...insightsOf(s),
          })),
        }
      },
    }),
    meta_ads_ads: op({
      description:
        'Ads of an ad account (or of one campaign or ad set) with their status, creative (title, body, link, thumbnail) and performance over a date range.',
      write: false,
      input: z.object({
        accountId,
        campaignId: objectId('campaign').optional(),
        adSetId: objectId('ad set').optional(),
        ...dates,
        activeOnly: z.boolean().default(false),
        limit,
      }),
      target: (i) =>
        `ads${i.adSetId ? ` of ad set ${i.adSetId}` : i.campaignId ? ` of campaign ${i.campaignId}` : ''} in ${i.accountId}, ${dateLabel(i)}`,
      check,
      run: async (ctx, i) => {
        const account = adAccountOf(ctx, i.accountId)
        const parent = i.adSetId ?? i.campaignId
        if (parent) {
          const { account: owner } = await ownerOf(ctx, parent)
          if (owner.id !== account.id) throw new ConnectorError(`${parent} is not in ${account.id}`)
        }
        const { data = [] } = await get<{ data?: Row[] }>(
          ctx.fetch,
          parent ? `${parent}/ads` : `${account.id}/ads`,
          {
            fields: `id,name,adset_id,campaign_id,status,effective_status,creative{id,title,body,object_story_spec,thumbnail_url,call_to_action_type},insights${rangeModifier(i)}{${METRICS}}`,
            limit: String(i.limit),
            ...statusFilter(i.activeOnly),
          },
        )
        return {
          currency: account.currency,
          ads: data.map((a) => {
            const link = a.creative?.object_story_spec?.link_data
            return {
              adId: a.id,
              name: a.name,
              adSetId: a.adset_id,
              campaignId: a.campaign_id,
              status: a.status,
              effectiveStatus: a.effective_status,
              creative: a.creative
                ? {
                    creativeId: a.creative.id,
                    title: a.creative.title ?? link?.name ?? null,
                    body: a.creative.body ?? link?.message ?? null,
                    link: link?.link ?? null,
                    callToAction: a.creative.call_to_action_type ?? null,
                    thumbnailUrl: a.creative.thumbnail_url ?? null,
                  }
                : null,
              ...insightsOf(a),
            }
          }),
        }
      },
    }),
    meta_ads_insights: op({
      description:
        'An Insights report on an ad account at the level asked (account, campaign, ad set or ad), over a date range, optionally broken down (age, gender, country, platform, placement…) and by day. For reports the other tools do not cover.',
      write: false,
      input: z.object({
        accountId,
        level: z.enum(['account', 'campaign', 'adset', 'ad']).default('campaign'),
        ...dates,
        breakdowns: z
          .array(
            z.enum([
              'age',
              'gender',
              'country',
              'region',
              'publisher_platform',
              'platform_position',
              'device_platform',
              'impression_device',
            ]),
          )
          .max(3)
          .default([])
          .describe('Split each row by these; Meta allows only some combinations'),
        timeIncrement: z
          .enum(['all_days', '1', '7', 'monthly'])
          .default('all_days')
          .describe('1: a row per day; 7: per week; all_days: one row for the range'),
        limit,
      }),
      target: (i) => `${i.level} insights of ${i.accountId}, ${dateLabel(i)}`,
      check,
      run: async (ctx, i) => {
        const account = adAccountOf(ctx, i.accountId)
        const names =
          i.level === 'account'
            ? ''
            : i.level === 'campaign'
              ? 'campaign_id,campaign_name,'
              : i.level === 'adset'
                ? 'campaign_id,campaign_name,adset_id,adset_name,'
                : 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,'
        const { data = [] } = await get<{ data?: Row[] }>(ctx.fetch, `${account.id}/insights`, {
          level: i.level,
          fields: `${names}${METRICS}`,
          ...range(i),
          ...(i.breakdowns.length ? { breakdowns: i.breakdowns.join(',') } : {}),
          time_increment: i.timeIncrement,
          limit: String(i.limit),
        })
        return {
          currency: account.currency,
          rows: data.map((r) => ({
            ...(r.campaign_id ? { campaignId: r.campaign_id, campaign: r.campaign_name } : {}),
            ...(r.adset_id ? { adSetId: r.adset_id, adSet: r.adset_name } : {}),
            ...(r.ad_id ? { adId: r.ad_id, ad: r.ad_name } : {}),
            ...Object.fromEntries(i.breakdowns.map((b) => [b, r[b]])),
            ...(i.timeIncrement !== 'all_days'
              ? { dateStart: r.date_start, dateStop: r.date_stop }
              : {}),
            ...metricsOf(r),
          })),
        }
      },
    }),
    meta_ads_set_status: op({
      description:
        'Pause or activate a campaign, ad set or ad. Activating starts spending (if its parents are active).',
      write: true,
      input: z.object({
        id: objectId('campaign, ad set or ad'),
        status: z.enum(['ACTIVE', 'PAUSED']),
      }),
      target: (i) => `${i.status === 'ACTIVE' ? 'activate' : 'pause'} ${i.id}`,
      check: async (ctx, i) => {
        await ownerOf(ctx, i.id)
        return null
      },
      run: async (ctx, i) => {
        const { object, account } = await ownerOf(ctx, i.id, 'name,status')
        await post(ctx.fetch, i.id, { status: i.status })
        return {
          id: i.id,
          name: object.name ?? null,
          accountId: account.id,
          before: object.status ?? null,
          status: i.status,
        }
      },
    }),
    meta_ads_set_budget: op({
      description:
        "Change a campaign's or ad set's daily or lifetime budget, in the ad account's currency (e.g. 25.5). The budget it already has (daily or lifetime) is the one changed, unless `kind` says otherwise; ad sets of a campaign with a campaign budget have none of their own.",
      write: true,
      input: z.object({
        id: objectId('campaign or ad set'),
        amount: z.number().positive().max(10_000_000),
        kind: z.enum(['daily', 'lifetime']).optional(),
      }),
      target: (i) => `${i.kind ?? 'current'} budget of ${i.id} → ${i.amount}`,
      check: async (ctx, i) => {
        await ownerOf(ctx, i.id)
        return null
      },
      run: async (ctx, i) => {
        const { object, account } = await ownerOf(ctx, i.id, 'name,daily_budget,lifetime_budget')
        const has =
          object.daily_budget && object.daily_budget !== '0'
            ? 'daily'
            : object.lifetime_budget && object.lifetime_budget !== '0'
              ? 'lifetime'
              : null
        const kind = i.kind ?? has
        if (!kind)
          throw new ConnectorError(
            `${i.id} has no budget of its own (its campaign's budget applies): change the campaign's`,
          )
        const field = kind === 'daily' ? 'daily_budget' : 'lifetime_budget'
        await post(ctx.fetch, i.id, { [field]: String(toMinor(i.amount, account.currency)) })
        return {
          id: i.id,
          name: object.name ?? null,
          accountId: account.id,
          currency: account.currency,
          budget: kind,
          before: fromMinor(object[field], account.currency),
          after: i.amount,
        }
      },
    }),
  },
}
