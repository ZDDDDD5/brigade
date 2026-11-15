// Google Ads' conversions (docs/analytics.md, "Google Ads"): a person who came from a Google ad
// (a gclid, gbraid or wbraid in the address, kept on User.attribution at sign-up,
// src/signup-source.ts) counts as a conversion when they sign up, and again when their first
// subscription starts. Each is kept as an AdConversion row when it happens, and the
// `ad-conversions` job sends the rows to Google through the Data Manager API (Google's way for
// new integrations since June 2026; the Google Ads API's uploadClickConversions refuses
// accounts that never used it). Only the click id, the time, an id of the row and, for a
// subscription, its price: no email address, no name.
//
// Off without its settings (src/config.ts): rows are still kept, and go once it is set.
import { env } from './config.js'
import { prisma } from './db.js'
import { noteFailure } from './ops/failures.js'
import type { AdClick } from './signup-source.js'

export type AdConversionKind = 'sign_up' | 'subscription'

const INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/datamanager'
/** Google takes a click's conversions for 90 days at most (its longest click window). */
const MAX_AGE_MS = 90 * 24 * 60 * 60_000
/** Tries before a row is given up, for errors that are not the row's own. */
const MAX_ATTEMPTS = 20
/** Rows sent per run: a few a day are expected. */
const BATCH = 50

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string }

export type AdsConfig = {
  customerId: string
  loginCustomerId?: string
  actions: Record<AdConversionKind, string>
  account: ServiceAccount
}

const digits = (value: string | undefined) => value?.replace(/-/g, '').trim()

/** The settings, checked, or null when any is missing or not what Google takes. */
export function adsConfig(source: Partial<typeof env> = env): AdsConfig | null {
  const customerId = digits(source.GOOGLE_ADS_CUSTOMER_ID)
  const loginCustomerId = digits(source.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || undefined
  const signUp = source.GOOGLE_ADS_SIGNUP_ACTION_ID?.trim()
  const subscription = source.GOOGLE_ADS_SUBSCRIPTION_ACTION_ID?.trim()
  if (!customerId || !signUp || !subscription || !source.GOOGLE_ADS_SERVICE_ACCOUNT) return null
  if (!/^\d{10}$/.test(customerId) || (loginCustomerId && !/^\d{10}$/.test(loginCustomerId)))
    return null
  if (!/^\d+$/.test(signUp) || !/^\d+$/.test(subscription)) return null
  let account: ServiceAccount
  try {
    account = JSON.parse(source.GOOGLE_ADS_SERVICE_ACCOUNT) as ServiceAccount
  } catch {
    return null
  }
  if (typeof account?.client_email !== 'string' || typeof account.private_key !== 'string')
    return null
  return {
    customerId,
    ...(loginCustomerId && { loginCustomerId }),
    actions: { sign_up: signUp, subscription },
    account,
  }
}

/** The click ids kept on a user's attribution, or null when they came from no Google ad. */
export function adClickOf(attribution: unknown): AdClick | null {
  const click = (attribution as { adClick?: AdClick } | null)?.adClick
  if (!click || typeof click !== 'object') return null
  const out: AdClick = {}
  for (const key of ['gclid', 'gbraid', 'wbraid'] as const)
    if (typeof click[key] === 'string' && click[key]) out[key] = click[key]
  return Object.keys(out).length ? out : null
}

/**
 * Keep a conversion of a person who came from a Google ad, once per kind (a second sign-up or
 * subscription of theirs is not counted again). Nothing for anyone else. Never throws.
 */
export async function recordAdConversion(
  userId: string,
  kind: AdConversionKind,
  details: { attribution?: unknown; value?: number; currency?: string; at?: Date } = {},
) {
  try {
    const attribution =
      details.attribution !== undefined
        ? details.attribution
        : (await prisma.user.findUnique({ where: { id: userId }, select: { attribution: true } }))
            ?.attribution
    if (!adClickOf(attribution)) return
    await prisma.adConversion.createMany({
      data: [
        {
          userId,
          kind,
          ...(details.at && { at: details.at }),
          ...(details.value !== undefined && { value: details.value }),
          ...(details.currency && { currency: details.currency.toUpperCase() }),
        },
      ],
      skipDuplicates: true,
    })
  } catch (error) {
    console.warn(`google-ads: could not keep a ${kind} conversion: ${String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// Google's access token, from the service account's key (a JWT it signs, RFC 7523)

const base64url = (bytes: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof bytes === 'string' ? bytes : new Uint8Array(bytes))
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

let cached: { email: string; token: string; until: number } | null = null

async function accessToken(account: ServiceAccount, now = Date.now()) {
  if (cached && cached.email === account.client_email && cached.until > now + 60_000)
    return cached.token
  const pem = account.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(pem, 'base64'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const iat = Math.floor(now / 1000)
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: account.token_uri ?? TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  )}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  )
  const response = await fetch(account.token_uri ?? TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${base64url(signature)}`,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
  }
  if (!response.ok || !body.access_token)
    throw new AdsError(`token: ${response.status} ${body.error ?? ''}`.trim(), false)
  cached = {
    email: account.client_email,
    token: body.access_token,
    until: now + (body.expires_in ?? 3600) * 1000,
  }
  return body.access_token
}

/** For tests: forget the access token kept between runs. */
export function forgetAdsToken() {
  cached = null
}

// ---------------------------------------------------------------------------
// Sending

/** A failure to send. `rowsFault`: the event itself was refused, and never will be taken. */
class AdsError extends Error {
  constructor(
    message: string,
    readonly rowsFault: boolean,
  ) {
    super(message)
    this.name = 'AdsError'
  }
}

type Row = {
  id: string
  kind: string
  at: Date
  value: number | null
  currency: string | null
  user: { attribution: unknown }
}

/** The request's body for one conversion: one event a request, as one bad event fails all. */
export function ingestBody(config: AdsConfig, row: Row, click: AdClick) {
  const kind = row.kind as AdConversionKind
  return {
    destinations: [
      {
        operatingAccount: { accountType: 'GOOGLE_ADS', accountId: config.customerId },
        ...(config.loginCustomerId && {
          loginAccount: { accountType: 'GOOGLE_ADS', accountId: config.loginCustomerId },
        }),
        productDestinationId: config.actions[kind],
      },
    ],
    events: [
      {
        adIdentifiers: click,
        eventTimestamp: row.at.toISOString(),
        // Google drops a second event with the same id: a row sent twice counts once.
        transactionId: row.id,
        eventSource: 'WEB',
        ...(row.value !== null &&
          row.currency && {
            conversionValue: row.value,
            currency: row.currency,
          }),
      },
    ],
  }
}

async function send(config: AdsConfig, row: Row, click: AdClick) {
  const token = await accessToken(config.account)
  const response = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(ingestBody(config, row, click)),
    signal: AbortSignal.timeout(20_000),
  })
  if (response.ok) return
  const text = (await response.text().catch(() => '')).slice(0, 500)
  // 400: this event is refused (a click id Google does not know, too old…). Anything else (the
  // key, the account's access, a quota, Google down) is not the row's: tried again later.
  if (response.status === 401) cached = null
  throw new AdsError(`ingest: ${response.status} ${text}`, response.status === 400)
}

/**
 * The `ad-conversions` job: the rows not sent yet, to Google. A row Google refuses is given up
 * with its error; any other failure stops the run, and its rows wait for the next. Rows past
 * Google's 90 days are given up unsent.
 */
export async function sendAdConversions(now = new Date(), config = adsConfig()) {
  if (!config) return { sent: 0, failed: 0 }
  const rows = await prisma.adConversion.findMany({
    where: { sentAt: null, failedAt: null },
    orderBy: { at: 'asc' },
    take: BATCH,
    select: {
      id: true,
      kind: true,
      at: true,
      value: true,
      currency: true,
      attempts: true,
      user: { select: { attribution: true } },
    },
  })
  let sent = 0
  let failed = 0
  const giveUp = async (id: string, error: string) => {
    failed++
    await prisma.adConversion.updateMany({
      where: { id, sentAt: null, failedAt: null },
      data: { failedAt: now, error: error.slice(0, 500) },
    })
  }
  for (const row of rows) {
    const click = adClickOf(row.user.attribution)
    if (!click) {
      await giveUp(row.id, 'no click id')
      continue
    }
    if (!(row.kind in config.actions)) {
      await giveUp(row.id, `unknown kind ${row.kind}`)
      continue
    }
    if (now.getTime() - row.at.getTime() > MAX_AGE_MS) {
      await giveUp(row.id, 'older than 90 days')
      continue
    }
    try {
      await send(config, row, click)
      sent++
      await prisma.adConversion.updateMany({
        where: { id: row.id, sentAt: null },
        data: { sentAt: now, attempts: { increment: 1 }, error: null },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof AdsError && error.rowsFault) {
        await prisma.adConversion.updateMany({
          where: { id: row.id },
          data: { attempts: { increment: 1 } },
        })
        await giveUp(row.id, message)
        continue
      }
      // Not this row's fault: counted, then the run stops, and the next one tries again.
      await prisma.adConversion.updateMany({
        where: { id: row.id, sentAt: null, failedAt: null },
        data: {
          attempts: { increment: 1 },
          error: message.slice(0, 500),
          ...(row.attempts + 1 >= MAX_ATTEMPTS && { failedAt: now }),
        },
      })
      noteFailure('google-ads', error instanceof Error ? error : new Error(message))
      break
    }
  }
  return { sent, failed }
}
