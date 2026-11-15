// Google Ads connector (Google Ads API, REST), on the account's OAuth credential in the vault and
// Brigade's developer token. One Brigade account is one Google sign-in; its owner then picks the
// Google Ads customer accounts teammates reach (Connection.settings), each with the manager
// account it is reached through (login-customer-id). Reports are GAQL queries; writes are
// mutates, each one atomic.
import { z } from 'zod'
import { env } from '../config.js'
import {
  ConnectorError,
  op,
  redact,
  type ConnectorContext,
  type ConnectorDefinition,
} from './types.js'

/** Google Ads API version: each is sunset about a year after its release (v26: Nov 2027). */
export const GOOGLE_ADS_VERSION = 'v26'
const API = `https://googleads.googleapis.com/${GOOGLE_ADS_VERSION}`

/** A customer account its owner picked, and the manager account it is reached through. */
export const AdsCustomer = z.object({
  id: z.string().regex(/^\d{10}$/),
  loginCustomerId: z.string().regex(/^\d{10}$/),
  name: z.string().nullable(),
  currency: z.string().optional(),
  timeZone: z.string().optional(),
})
export type AdsCustomer = z.infer<typeof AdsCustomer>
export const AdsSettings = z.object({ customers: z.array(AdsCustomer).max(50) })
export type AdsSettings = z.infer<typeof AdsSettings>

/** 1234567890 as Google Ads shows it: 123-456-7890. */
export const dashed = (id: string) => id.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3')

const customerId = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{10}$/, 'A 10-digit Google Ads customer ID, e.g. 123-456-7890'))
  .describe('The Google Ads account, e.g. 123-456-7890 (google_ads_list_accounts lists them)')
const numericId = (what: string) =>
  z
    .string()
    .regex(/^\d{1,20}$/, `A ${what} ID: digits only`)
    .describe(`The ${what} ID (digits)`)
const during = z
  .enum([
    'TODAY',
    'YESTERDAY',
    'LAST_7_DAYS',
    'LAST_14_DAYS',
    'LAST_30_DAYS',
    'LAST_BUSINESS_WEEK',
    'THIS_WEEK_MON_TODAY',
    'LAST_WEEK_MON_SUN',
    'THIS_MONTH',
    'LAST_MONTH',
  ])
  .default('LAST_30_DAYS')
  .describe(
    "A range ending today, in the account's time zone. Ignored when startDate and endDate are given",
  )
const dates = {
  during,
  startDate: z.iso.date().optional().describe("YYYY-MM-DD, in the account's time zone"),
  endDate: z.iso.date().optional().describe('YYYY-MM-DD, inclusive'),
}
const limit = z.number().int().min(1).max(1000).default(100).describe('Rows at most')
const status = z.enum(['ENABLED', 'PAUSED'])
const matchType = z.enum(['EXACT', 'PHRASE', 'BROAD'])
const keyword = z.object({
  text: z.string().trim().min(1).max(80).describe('The keyword, without match-type symbols'),
  matchType: matchType.default('PHRASE'),
})

type DateInput = { during: string; startDate?: string | undefined; endDate?: string | undefined }
/** The WHERE clause's date range: the dates when both are given, else the named range. */
export const dateClause = (i: DateInput) =>
  i.startDate && i.endDate
    ? `segments.date BETWEEN '${i.startDate}' AND '${i.endDate}'`
    : `segments.date DURING ${i.during}`
const dateLabel = (i: DateInput) =>
  i.startDate && i.endDate
    ? `${i.startDate} to ${i.endDate}`
    : i.during.toLowerCase().replaceAll('_', ' ')

const METRICS =
  'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.ctr, metrics.average_cpc'

/** Money in micros (a string, as int64 comes in JSON) as an amount in the account's currency. */
const money = (micros: unknown) =>
  micros === undefined || micros === null ? 0 : Math.round(Number(micros) / 10_000) / 100

type Metrics = {
  impressions?: string
  clicks?: string
  costMicros?: string
  conversions?: number
  conversionsValue?: number
  ctr?: number
  averageCpc?: number | string
}
/** A row's metrics as numbers; Google leaves out those at zero. */
export const metricsOf = (m: Metrics = {}) => ({
  impressions: Number(m.impressions ?? 0),
  clicks: Number(m.clicks ?? 0),
  cost: money(m.costMicros),
  conversions: Math.round((m.conversions ?? 0) * 100) / 100,
  conversionsValue: Math.round((m.conversionsValue ?? 0) * 100) / 100,
  ctr: Math.round((m.ctr ?? 0) * 10_000) / 10_000,
  averageCpc: money(m.averageCpc),
})

// biome-ignore lint: GAQL rows are untyped JSON, shaped by the query's fields
type Row = Record<string, any>

/**
 * Google Ads' errors: the readable ones are in details[].errors[], under a generic message
 * ("Request contains an invalid argument.").
 */
export async function adsJson<T>(response: Response): Promise<T> {
  const body = await response.text()
  if (!response.ok) {
    let message = body.slice(0, 500)
    try {
      const parsed = JSON.parse(body) as {
        error?: {
          message?: string
          details?: { errors?: { message?: string; errorCode?: Record<string, string> }[] }[]
        }
      }
      const errors = (parsed.error?.details ?? []).flatMap((d) => d.errors ?? [])
      message = errors.length
        ? errors
            .map((e) => {
              const code = e.errorCode ? Object.values(e.errorCode)[0] : undefined
              return code ? `${e.message} (${code})` : e.message
            })
            .join('; ')
        : (parsed.error?.message ?? message)
    } catch {
      // not JSON
    }
    throw new ConnectorError(redact(`${response.status}: ${message}`), response.status)
  }
  return (body ? JSON.parse(body) : {}) as T
}

const developerToken = () => {
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN)
    throw new ConnectorError(
      'Google Ads is not configured on this Brigade server (no developer token)',
    )
  return env.GOOGLE_ADS_DEVELOPER_TOKEN
}

/** The picked customers of an account, from its settings. */
export const pickedCustomers = (settings: unknown): AdsCustomer[] => {
  const parsed = AdsSettings.safeParse(settings)
  return parsed.success ? parsed.data.customers : []
}

/** The customer a call names, if its owner picked it; else why not. */
function customerOf(ctx: Pick<ConnectorContext, 'settings'>, id: string) {
  const picked = pickedCustomers(ctx.settings)
  const customer = picked.find((c) => c.id === id)
  if (customer) return customer
  throw new ConnectorError(
    picked.length
      ? `${dashed(id)} is not one of the Google Ads accounts picked for this connection (${picked.map((c) => dashed(c.id)).join(', ')}). Its owner picks them in Apps › Google Ads.`
      : 'No Google Ads account is picked for this connection yet: its owner picks them in Apps › Google Ads, after signing in.',
  )
}

const check = async (ctx: ConnectorContext, i: { customerId: string }) => {
  customerOf(ctx, i.customerId)
  return null
}

const headers = (loginCustomerId?: string) => ({
  'content-type': 'application/json',
  'developer-token': developerToken(),
  ...(loginCustomerId ? { 'login-customer-id': loginCustomerId } : {}),
})

/** A GAQL query on a customer, through the manager it is reached by. One page (up to 10,000 rows). */
export async function search(
  fetch: ConnectorContext['fetch'],
  customer: Pick<AdsCustomer, 'id' | 'loginCustomerId'>,
  query: string,
  pageToken?: string,
) {
  return adsJson<{ results?: Row[]; nextPageToken?: string; fieldMask?: string }>(
    await fetch(`${API}/customers/${customer.id}/googleAds:search`, {
      method: 'POST',
      headers: headers(customer.loginCustomerId),
      body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
    }),
  )
}

async function mutate(
  ctx: ConnectorContext,
  customer: AdsCustomer,
  service: string,
  operations: unknown[],
) {
  const result = await adsJson<{ results?: { resourceName?: string }[] }>(
    await ctx.fetch(`${API}/customers/${customer.id}/${service}:mutate`, {
      method: 'POST',
      headers: headers(customer.loginCustomerId),
      body: JSON.stringify({ operations }),
    }),
  )
  return (result.results ?? []).map((r) => r.resourceName).filter(Boolean) as string[]
}

const rows = async (ctx: ConnectorContext, id: string, query: string) => {
  const customer = customerOf(ctx, id)
  return { customer, rows: (await search(ctx.fetch, customer, query)).results ?? [] }
}

/** Every customer account the signed-in Google account reaches, through each manager it holds. */
export async function listAdsCustomers(fetch: ConnectorContext['fetch']) {
  const accessible = await adsJson<{ resourceNames?: string[] }>(
    await fetch(`${API}/customers:listAccessibleCustomers`, { headers: headers() }),
  )
  const roots = (accessible.resourceNames ?? [])
    .map((r) => r.replace(/^customers\//, ''))
    .filter((id) => /^\d{10}$/.test(id))
    .slice(0, 25)
  const found = new Map<
    string,
    AdsCustomer & { manager: boolean; status: string; managerName: string | null }
  >()
  const failed: { id: string; error: string }[] = []
  await Promise.all(
    roots.map(async (root) => {
      try {
        const { results = [] } = await search(
          fetch,
          { id: root, loginCustomerId: root },
          'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.level, customer_client.currency_code, customer_client.time_zone, customer_client.status FROM customer_client',
        )
        const rootName =
          results.find((r) => String(r.customerClient?.id) === root)?.customerClient
            ?.descriptiveName ?? null
        for (const { customerClient: c } of results) {
          const id = String(c?.id ?? '')
          if (!/^\d{10}$/.test(id)) continue
          // Reached directly beats reached through a manager.
          const prior = found.get(id)
          if (prior && prior.loginCustomerId === id) continue
          found.set(id, {
            id,
            loginCustomerId: root,
            name: c.descriptiveName ?? null,
            currency: c.currencyCode,
            timeZone: c.timeZone,
            manager: Boolean(c.manager),
            status: c.status ?? 'UNKNOWN',
            managerName: root === id ? null : rootName,
          })
        }
      } catch (error) {
        failed.push({ id: root, error: error instanceof Error ? error.message : String(error) })
      }
    }),
  )
  return {
    customers: [...found.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)),
    failed,
  }
}

/** Campaign, ad group and their names, flattened. */
const where = (r: Row) => ({
  ...(r.campaign ? { campaignId: r.campaign.id, campaign: r.campaign.name } : {}),
  ...(r.adGroup ? { adGroupId: r.adGroup.id, adGroup: r.adGroup.name } : {}),
})
const filters = (i: { campaignId?: string | undefined; adGroupId?: string | undefined }) =>
  [
    i.campaignId ? `campaign.id = ${i.campaignId}` : null,
    i.adGroupId ? `ad_group.id = ${i.adGroupId}` : null,
  ].filter(Boolean) as string[]
const and = (clauses: string[]) => clauses.join(' AND ')
const scopeLabel = (i: { campaignId?: string | undefined; adGroupId?: string | undefined }) =>
  i.adGroupId ? ` of ad group ${i.adGroupId}` : i.campaignId ? ` of campaign ${i.campaignId}` : ''

const resource = (customer: string, collection: string, id: string) =>
  `customers/${customer}/${collection}/${id}`

export const googleAds: ConnectorDefinition = {
  kind: 'google_ads',
  label: 'Google Ads',
  auth: 'google',
  operations: {
    google_ads_list_accounts: op({
      description:
        "The Google Ads accounts this connection reaches (picked by its owner), with each one's currency and time zone. Every other tool names one by its customerId.",
      write: false,
      input: z.object({}),
      target: () => 'account list',
      run: async (ctx) => ({
        accounts: pickedCustomers(ctx.settings).map((c) => ({
          customerId: dashed(c.id),
          name: c.name,
          currency: c.currency,
          timeZone: c.timeZone,
          ...(c.loginCustomerId !== c.id ? { throughManager: dashed(c.loginCustomerId) } : {}),
        })),
      }),
    }),
    google_ads_campaigns: op({
      description:
        'Campaigns of an account with their status, type, bidding, daily budget and performance (impressions, clicks, cost, conversions, CTR, average CPC) over a date range, by cost. Money is in the account currency.',
      write: false,
      input: z.object({
        customerId,
        ...dates,
        includePaused: z.boolean().default(true),
        limit,
      }),
      target: (i) => `campaigns of ${dashed(i.customerId)}, ${dateLabel(i)}`,
      check,
      run: async (ctx, i) => {
        const { rows: results } = await rows(
          ctx,
          i.customerId,
          `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros, campaign_budget.explicitly_shared, ${METRICS} FROM campaign WHERE ${and([dateClause(i), i.includePaused ? "campaign.status != 'REMOVED'" : "campaign.status = 'ENABLED'"])} ORDER BY metrics.cost_micros DESC LIMIT ${i.limit}`,
        )
        return {
          campaigns: results.map((r) => ({
            campaignId: r.campaign?.id,
            name: r.campaign?.name,
            status: r.campaign?.status,
            type: r.campaign?.advertisingChannelType,
            bidding: r.campaign?.biddingStrategyType,
            dailyBudget: money(r.campaignBudget?.amountMicros),
            ...(r.campaignBudget?.explicitlyShared ? { sharedBudget: true } : {}),
            ...metricsOf(r.metrics),
          })),
        }
      },
    }),
    google_ads_ad_groups: op({
      description:
        'Ad groups of an account (or of one campaign) with their status, default CPC bid and performance over a date range, by cost.',
      write: false,
      input: z.object({
        customerId,
        campaignId: numericId('campaign').optional(),
        ...dates,
        limit,
      }),
      target: (i) => `ad groups${scopeLabel(i)} in ${dashed(i.customerId)}, ${dateLabel(i)}`,
      check,
      run: async (ctx, i) => {
        const { rows: results } = await rows(
          ctx,
          i.customerId,
          `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros, ${METRICS} FROM ad_group WHERE ${and([dateClause(i), "ad_group.status != 'REMOVED'", "campaign.status != 'REMOVED'", ...filters(i)])} ORDER BY metrics.cost_micros DESC LIMIT ${i.limit}`,
        )
        return {
          adGroups: results.map((r) => ({
            ...where(r),
            status: r.adGroup?.status,
            type: r.adGroup?.type,
            cpcBid: money(r.adGroup?.cpcBidMicros),
            ...metricsOf(r.metrics),
          })),
        }
      },
    }),
    google_ads_keywords: op({
      description:
        'Keywords of an account (or of a campaign or ad group) with match type, status, quality score, bid and performance over a date range, by cost. criterionId and adGroupId identify a keyword for google_ads_set_status and google_ads_remove_keywords.',
      write: false,
      input: z.object({
        customerId,
        campaignId: numericId('campaign').optional(),
        adGroupId: numericId('ad group').optional(),
        ...dates,
        limit,
      }),
      target: (i) => `keywords${scopeLabel(i)} in ${dashed(i.customerId)}, ${dateLabel(i)}`,
      check,
      run: async (ctx, i) => {
        const { rows: results } = await rows(
          ctx,
          i.customerId,
          `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.quality_info.quality_score, ad_group_criterion.effective_cpc_bid_micros, ${METRICS} FROM keyword_view WHERE ${and([dateClause(i), "ad_group_criterion.status != 'REMOVED'", ...filters(i)])} ORDER BY metrics.cost_micros DESC LIMIT ${i.limit}`,
        )
        return {
          keywords: results.map((r) => ({
            ...where(r),
            criterionId: r.adGroupCriterion?.criterionId,
            keyword: r.adGroupCriterion?.keyword?.text,
            matchType: r.adGroupCriterion?.keyword?.matchType,
            status: r.adGroupCriterion?.status,
            qualityScore: r.adGroupCriterion?.qualityInfo?.qualityScore ?? null,
            cpcBid: money(r.adGroupCriterion?.effectiveCpcBidMicros),
            ...metricsOf(r.metrics),
          })),
        }
      },
    }),
    google_ads_search_terms: op({
      description:
        'What people actually searched before an ad showed (search terms report), with the ad group it matched and performance over a date range, by impressions: to find new keywords and negative keywords.',
      write: false,
      input: z.object({
        customerId,
        campaignId: numericId('campaign').optional(),
        adGroupId: numericId('ad group').optional(),
        ...dates,
        limit,
      }),
      target: (i) => `search terms${scopeLabel(i)} in ${dashed(i.customerId)}, ${dateLabel(i)}`,
      check,
      run: async (ctx, i) => {
        const { rows: results } = await rows(
          ctx,
          i.customerId,
          `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, search_term_view.search_term, search_term_view.status, ${METRICS} FROM search_term_view WHERE ${and([dateClause(i), ...filters(i)])} ORDER BY metrics.impressions DESC LIMIT ${i.limit}`,
        )
        return {
          searchTerms: results.map((r) => ({
            ...where(r),
            searchTerm: r.searchTermView?.searchTerm,
            // ADDED, EXCLUDED, ADDED_EXCLUDED or NONE: whether it is already a keyword or negative.
            status: r.searchTermView?.status,
            ...metricsOf(r.metrics),
          })),
        }
      },
    }),
    google_ads_ads: op({
      description:
        'Ads of an account (or of a campaign or ad group) with type, status, review status, final URLs, responsive search ad headlines and descriptions, and performance over a date range, by cost. adId and adGroupId identify an ad for google_ads_set_status.',
      write: false,
      input: z.object({
        customerId,
        campaignId: numericId('campaign').optional(),
        adGroupId: numericId('ad group').optional(),
        ...dates,
        limit,
      }),
      target: (i) => `ads${scopeLabel(i)} in ${dashed(i.customerId)}, ${dateLabel(i)}`,
      check,
      run: async (ctx, i) => {
        const { rows: results } = await rows(
          ctx,
          i.customerId,
          `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ${METRICS} FROM ad_group_ad WHERE ${and([dateClause(i), "ad_group_ad.status != 'REMOVED'", ...filters(i)])} ORDER BY metrics.cost_micros DESC LIMIT ${i.limit}`,
        )
        return {
          ads: results.map((r) => {
            const ad = r.adGroupAd?.ad ?? {}
            const rsa = ad.responsiveSearchAd
            return {
              ...where(r),
              adId: ad.id,
              type: ad.type,
              status: r.adGroupAd?.status,
              review: r.adGroupAd?.policySummary?.approvalStatus,
              finalUrls: ad.finalUrls ?? [],
              ...(rsa
                ? {
                    headlines: (rsa.headlines ?? []).map((h: { text?: string }) => h.text),
                    descriptions: (rsa.descriptions ?? []).map((d: { text?: string }) => d.text),
                  }
                : {}),
              ...metricsOf(r.metrics),
            }
          }),
        }
      },
    }),
    google_ads_negative_keywords: op({
      description:
        'Negative keywords of an account, on its campaigns and ad groups (or of one campaign), with the criterionId google_ads_remove_negative_keywords takes.',
      write: false,
      input: z.object({ customerId, campaignId: numericId('campaign').optional(), limit }),
      target: (i) => `negative keywords${scopeLabel(i)} in ${dashed(i.customerId)}`,
      check,
      run: async (ctx, i) => {
        const customer = customerOf(ctx, i.customerId)
        const byCampaign = i.campaignId ? ` AND campaign.id = ${i.campaignId}` : ''
        const [campaigns, adGroups] = await Promise.all([
          search(
            ctx.fetch,
            customer,
            `SELECT campaign.id, campaign.name, campaign_criterion.criterion_id, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'${byCampaign} LIMIT ${i.limit}`,
          ),
          search(
            ctx.fetch,
            customer,
            `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group_criterion.negative = TRUE AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'${byCampaign} LIMIT ${i.limit}`,
          ),
        ])
        return {
          campaignNegatives: (campaigns.results ?? []).map((r) => ({
            ...where(r),
            criterionId: r.campaignCriterion?.criterionId,
            keyword: r.campaignCriterion?.keyword?.text,
            matchType: r.campaignCriterion?.keyword?.matchType,
          })),
          adGroupNegatives: (adGroups.results ?? []).map((r) => ({
            ...where(r),
            criterionId: r.adGroupCriterion?.criterionId,
            keyword: r.adGroupCriterion?.keyword?.text,
            matchType: r.adGroupCriterion?.keyword?.matchType,
          })),
        }
      },
    }),
    google_ads_search: op({
      description:
        "Any Google Ads Query Language (GAQL) query on an account, for reports the other tools do not cover (e.g. SELECT segments.date, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS). Rows come as Google returns them: camelCase fields, int64 as strings, money in micros (1,000,000 = one unit of the account's currency). Reads only.",
      write: false,
      input: z.object({
        customerId,
        query: z.string().trim().min(10).max(10_000).describe('A GAQL SELECT … FROM … query'),
        pageToken: z.string().max(2000).optional().describe('nextPageToken of the previous page'),
        limit: z.number().int().min(1).max(1000).default(200).describe('Rows returned at most'),
      }),
      target: (i) => `query on ${dashed(i.customerId)}`,
      check: async (ctx, i) => {
        customerOf(ctx, i.customerId)
        return /^\s*select\b/i.test(i.query) ? null : 'A GAQL query starts with SELECT'
      },
      run: async (ctx, i) => {
        const customer = customerOf(ctx, i.customerId)
        const page = await search(ctx.fetch, customer, i.query, i.pageToken)
        const results = page.results ?? []
        return {
          rows: results.slice(0, i.limit),
          ...(results.length > i.limit
            ? {
                truncated: `${results.length - i.limit} more rows on this page: add LIMIT or narrow the query`,
              }
            : {}),
          ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
        }
      },
    }),

    google_ads_set_campaign_budget: op({
      description:
        "Set a campaign's average daily budget, in the account currency. A budget shared with other campaigns changes for all of them: it is refused unless allowShared is true.",
      write: true,
      input: z.object({
        customerId,
        campaignId: numericId('campaign'),
        dailyBudget: z
          .number()
          .positive()
          .max(1_000_000)
          .describe('Per day, in the account currency, e.g. 25.5'),
        allowShared: z.boolean().default(false),
      }),
      target: (i) =>
        `daily budget of campaign ${i.campaignId} in ${dashed(i.customerId)} to ${i.dailyBudget}`,
      check,
      run: async (ctx, i) => {
        const { customer, rows: results } = await rows(
          ctx,
          i.customerId,
          `SELECT campaign.id, campaign.name, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign WHERE campaign.id = ${i.campaignId}`,
        )
        const budget = results[0]?.campaignBudget
        if (!budget?.resourceName)
          throw new ConnectorError(
            `No campaign ${i.campaignId} with a budget in ${dashed(i.customerId)}`,
          )
        const sharedWith = Number(budget.referenceCount ?? 1)
        if (budget.explicitlyShared && sharedWith > 1 && !i.allowShared)
          throw new ConnectorError(
            `Campaign ${i.campaignId}'s budget is shared by ${sharedWith} campaigns: changing it changes all of them. Call again with allowShared: true to do so.`,
          )
        // Budgets go in steps of the currency's smallest unit: one cent is 10,000 micros.
        const micros = Math.round(i.dailyBudget * 100) * 10_000
        await mutate(ctx, customer, 'campaignBudgets', [
          {
            updateMask: 'amountMicros',
            update: { resourceName: budget.resourceName, amountMicros: String(micros) },
          },
        ])
        return {
          campaign: results[0]?.campaign?.name,
          before: money(budget.amountMicros),
          after: money(micros),
          ...(budget.explicitlyShared ? { sharedBy: sharedWith } : {}),
        }
      },
    }),
    google_ads_set_status: op({
      description:
        'Pause or enable campaigns, ad groups, ads or keywords. An ad is "adGroupId~adId", a keyword "adGroupId~criterionId" (from google_ads_ads and google_ads_keywords).',
      write: true,
      input: z.object({
        customerId,
        level: z.enum(['campaign', 'ad_group', 'ad', 'keyword']),
        ids: z
          .array(z.string().regex(/^\d{1,20}(~\d{1,20})?$/))
          .min(1)
          .max(50)
          .describe(
            'campaign and ad_group: their IDs; ad and keyword: "adGroupId~adId" or "adGroupId~criterionId"',
          ),
        status,
      }),
      target: (i) =>
        `${i.status === 'PAUSED' ? 'pause' : 'enable'} ${i.level.replace('_', ' ')} ${i.ids.join(', ')} in ${dashed(i.customerId)}`,
      check: async (ctx, i) => {
        customerOf(ctx, i.customerId)
        const pair = i.level === 'ad' || i.level === 'keyword'
        const bad = i.ids.find((id) => id.includes('~') !== pair)
        return bad
          ? pair
            ? `A ${i.level} is "adGroupId~${i.level === 'ad' ? 'adId' : 'criterionId'}": ${bad}`
            : `A ${i.level.replace('_', ' ')} is its ID alone: ${bad}`
          : null
      },
      run: async (ctx, i) => {
        const customer = customerOf(ctx, i.customerId)
        const [service, collection] = {
          campaign: ['campaigns', 'campaigns'],
          ad_group: ['adGroups', 'adGroups'],
          ad: ['adGroupAds', 'adGroupAds'],
          keyword: ['adGroupCriteria', 'adGroupCriteria'],
        }[i.level] as [string, string]
        const changed = await mutate(
          ctx,
          customer,
          service,
          i.ids.map((id) => ({
            updateMask: 'status',
            update: { resourceName: resource(customer.id, collection, id), status: i.status },
          })),
        )
        return { status: i.status, changed }
      },
    }),
    google_ads_add_keywords: op({
      description:
        'Add keywords to an ad group, each with its match type, and optionally its own max CPC bid in the account currency.',
      write: true,
      input: z.object({
        customerId,
        adGroupId: numericId('ad group'),
        keywords: z
          .array(keyword.extend({ cpcBid: z.number().positive().max(10_000).optional() }))
          .min(1)
          .max(50),
        status: status.default('ENABLED'),
      }),
      target: (i) =>
        `add ${i.keywords.map((k) => `"${k.text}" (${k.matchType.toLowerCase()})`).join(', ')} to ad group ${i.adGroupId} in ${dashed(i.customerId)}`,
      check,
      run: async (ctx, i) => {
        const customer = customerOf(ctx, i.customerId)
        const added = await mutate(
          ctx,
          customer,
          'adGroupCriteria',
          i.keywords.map((k) => ({
            create: {
              adGroup: resource(customer.id, 'adGroups', i.adGroupId),
              status: i.status,
              keyword: { text: k.text, matchType: k.matchType },
              ...(k.cpcBid ? { cpcBidMicros: String(Math.round(k.cpcBid * 100) * 10_000) } : {}),
            },
          })),
        )
        return { added }
      },
    }),
    google_ads_remove_keywords: op({
      description:
        'Remove keywords from an ad group, by criterionId (google_ads_keywords). Removed keywords keep their past data but cannot be enabled again; pause them instead to keep that choice.',
      write: true,
      input: z.object({
        customerId,
        adGroupId: numericId('ad group'),
        criterionIds: z.array(numericId('keyword criterion')).min(1).max(50),
      }),
      target: (i) =>
        `remove keywords ${i.criterionIds.join(', ')} of ad group ${i.adGroupId} in ${dashed(i.customerId)}`,
      check,
      run: async (ctx, i) => {
        const customer = customerOf(ctx, i.customerId)
        const removed = await mutate(
          ctx,
          customer,
          'adGroupCriteria',
          i.criterionIds.map((id) => ({
            remove: resource(customer.id, 'adGroupCriteria', `${i.adGroupId}~${id}`),
          })),
        )
        return { removed }
      },
    }),
    google_ads_add_negative_keywords: op({
      description:
        'Add negative keywords to a campaign or an ad group, so its ads stop showing for searches that match them.',
      write: true,
      input: z.object({
        customerId,
        level: z.enum(['campaign', 'ad_group']),
        id: z
          .string()
          .regex(/^\d{1,20}$/)
          .describe('The campaign or ad group ID'),
        keywords: z.array(keyword).min(1).max(100),
      }),
      target: (i) =>
        `negatives ${i.keywords.map((k) => `"${k.text}" (${k.matchType.toLowerCase()})`).join(', ')} on ${i.level.replace('_', ' ')} ${i.id} in ${dashed(i.customerId)}`,
      check,
      run: async (ctx, i) => {
        const customer = customerOf(ctx, i.customerId)
        const campaign = i.level === 'campaign'
        const added = await mutate(
          ctx,
          customer,
          campaign ? 'campaignCriteria' : 'adGroupCriteria',
          i.keywords.map((k) => ({
            create: {
              ...(campaign
                ? { campaign: resource(customer.id, 'campaigns', i.id) }
                : { adGroup: resource(customer.id, 'adGroups', i.id) }),
              negative: true,
              keyword: { text: k.text, matchType: k.matchType },
            },
          })),
        )
        return { added }
      },
    }),
    google_ads_remove_negative_keywords: op({
      description:
        'Remove negative keywords from a campaign or an ad group, by criterionId (google_ads_negative_keywords).',
      write: true,
      input: z.object({
        customerId,
        level: z.enum(['campaign', 'ad_group']),
        id: z
          .string()
          .regex(/^\d{1,20}$/)
          .describe('The campaign or ad group ID'),
        criterionIds: z.array(numericId('negative keyword criterion')).min(1).max(100),
      }),
      target: (i) =>
        `remove negatives ${i.criterionIds.join(', ')} of ${i.level.replace('_', ' ')} ${i.id} in ${dashed(i.customerId)}`,
      check,
      run: async (ctx, i) => {
        const customer = customerOf(ctx, i.customerId)
        const collection = i.level === 'campaign' ? 'campaignCriteria' : 'adGroupCriteria'
        const removed = await mutate(
          ctx,
          customer,
          collection,
          i.criterionIds.map((id) => ({
            remove: resource(customer.id, collection, `${i.id}~${id}`),
          })),
        )
        return { removed }
      },
    }),
    google_ads_create_responsive_search_ad: op({
      description:
        'Create a responsive search ad in an ad group: 3 to 15 headlines (30 characters each), 2 to 4 descriptions (90 each), the landing page and optional display paths. It starts paused unless status is ENABLED; Google reviews it before it shows.',
      write: true,
      input: z.object({
        customerId,
        adGroupId: numericId('ad group'),
        headlines: z.array(z.string().trim().min(1).max(30)).min(3).max(15),
        descriptions: z.array(z.string().trim().min(1).max(90)).min(2).max(4),
        finalUrl: z.url().max(2048).describe('The landing page'),
        path1: z.string().trim().max(15).optional().describe('Shown after the domain in the ad'),
        path2: z.string().trim().max(15).optional(),
        status: status.default('PAUSED'),
      }),
      target: (i) =>
        `${i.status === 'PAUSED' ? 'paused ' : ''}responsive search ad "${i.headlines[0]}" in ad group ${i.adGroupId} of ${dashed(i.customerId)}`,
      check: async (ctx, i) => {
        customerOf(ctx, i.customerId)
        return i.path2 && !i.path1 ? 'path2 needs path1' : null
      },
      run: async (ctx, i) => {
        const customer = customerOf(ctx, i.customerId)
        const [created] = await mutate(ctx, customer, 'adGroupAds', [
          {
            create: {
              adGroup: resource(customer.id, 'adGroups', i.adGroupId),
              status: i.status,
              ad: {
                finalUrls: [i.finalUrl],
                responsiveSearchAd: {
                  headlines: i.headlines.map((text) => ({ text })),
                  descriptions: i.descriptions.map((text) => ({ text })),
                  ...(i.path1 ? { path1: i.path1 } : {}),
                  ...(i.path2 ? { path2: i.path2 } : {}),
                },
              },
            },
          },
        ])
        return { created, status: i.status }
      },
    }),
  },
}
