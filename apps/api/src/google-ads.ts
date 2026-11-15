// Google Ads' conversions (docs/analytics.md, "Google Ads"): a person who came from a Google ad
// (a gclid, gbraid or wbraid in the address, kept on User.attribution at sign-up,
// src/signup-source.ts) counts as a conversion when they sign up, and again when their first
// subscription starts. Each is kept as an AdConversion row in the same transaction as what it
// counts, and the `ad-conversions` job sends the rows to Google through the Data Manager API
// (Google's way for new integrations since June 2026; the Google Ads API's
// uploadClickConversions refuses accounts that never used it). Google takes a request at once
// and processes it later: the job reads each request's status on its next runs, and sends again
// what failed for a reason that may pass (a click too recent). Only the click id, the time, an
// id of the row and, for a subscription, its price: no email address, no name.
//
// Off without its settings (src/config.ts): rows are still kept, and go once it is set.
import { env } from './config.js'
import { prisma, type Prisma } from './db.js'
import { noteFailure } from './ops/failures.js'
import type { AdClick } from './signup-source.js'

export type AdConversionKind = 'sign_up' | 'subscription'

const INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest'
const STATUS_URL = 'https://datamanager.googleapis.com/v1/requestStatus:retrieve'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/datamanager'
/** Google takes a click's conversions for 90 days at most (its longest click window). */
const MAX_AGE_MS = 90 * 24 * 60 * 60_000
/** Tries before a row is given up, for errors that are not the row's own. */
const MAX_ATTEMPTS = 20
/** Rows sent, and requests checked, per run: a few a day are expected. */
const BATCH = 50
/** A conversion is first sent this long after it happened: Google refuses too recent a click. */
export const FIRST_DELAY_MS = 6 * 60 * 60_000
/** And sent again this long after Google said the click was too recent, or failed inside. */
const RETRY_DELAY_MS = 6 * 60 * 60_000
/** A request whose status is first read this long after it was taken. */
const CHECK_AFTER_MS = 30 * 60_000
/** A request Google still says nothing final about after this long is sent again. */
const STALE_REQUEST_MS = 3 * 24 * 60 * 60_000
/** Processing failures that may pass: the conversion is sent again later. */
const RETRY_REASONS = new Set([
  'PROCESSING_ERROR_REASON_TOO_RECENT_CLICK',
  'PROCESSING_ERROR_REASON_INTERNAL_ERROR',
  'PROCESSING_ERROR_REASON_DESTINATION_TOO_RECENTLY_CREATED',
])
/** Google has the conversion already: as good as taken. */
const DONE_REASONS = new Set([
  'PROCESSING_ERROR_REASON_DUPLICATE_TRANSACTION_ID',
  'PROCESSING_ERROR_REASON_DUPLICATE_GCLID',
])

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
 * subscription of theirs is not counted again), in the caller's transaction: it is kept with
 * what it counts, or neither is. Nothing for anyone else.
 */
export async function recordAdConversion(
  tx: Prisma.TransactionClient,
  userId: string,
  kind: AdConversionKind,
  details: { attribution?: unknown; value?: number; currency?: string; at?: Date } = {},
) {
  const attribution =
    details.attribution !== undefined
      ? details.attribution
      : (await tx.user.findUnique({ where: { id: userId }, select: { attribution: true } }))
          ?.attribution
  if (!adClickOf(attribution)) return
  const at = details.at ?? new Date()
  await tx.adConversion.createMany({
    data: [
      {
        userId,
        kind,
        at,
        sendAfter: new Date(at.getTime() + FIRST_DELAY_MS),
        ...(details.value !== undefined && { value: details.value }),
        ...(details.currency && { currency: details.currency.toUpperCase() }),
      },
    ],
    skipDuplicates: true,
  })
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

/** Send one conversion; Google's id of the request that took it. */
async function send(config: AdsConfig, row: Row, click: AdClick) {
  const token = await accessToken(config.account)
  const response = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(ingestBody(config, row, click)),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 500)
    // 400: this event is refused (a click id Google does not know…). Anything else (the key,
    // the account's access, a quota, Google down) is not the row's: tried again later.
    if (response.status === 401) cached = null
    throw new AdsError(`ingest: ${response.status} ${text}`, response.status === 400)
  }
  const body = (await response.json().catch(() => ({}))) as { requestId?: string }
  return body.requestId ?? null
}

type Status = { outcome: 'done' | 'pending' | 'retry' | 'failed'; reason?: string }

/** What Google says of a request it took: processed, still processing, or failed and why. */
async function statusOf(config: AdsConfig, requestId: string): Promise<Status> {
  const token = await accessToken(config.account)
  const response = await fetch(`${STATUS_URL}?${new URLSearchParams({ requestId })}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    if (response.status === 401) cached = null
    const text = (await response.text().catch(() => '')).slice(0, 300)
    throw new AdsError(`status: ${response.status} ${text}`, false)
  }
  const body = (await response.json().catch(() => ({}))) as {
    requestStatusPerDestination?: {
      requestStatus?: string
      errorInfo?: { errorCounts?: { reason?: string }[] }
    }[]
  }
  const destination = body.requestStatusPerDestination?.[0]
  const state = destination?.requestStatus
  if (state === 'SUCCESS') return { outcome: 'done' }
  if (state !== 'FAILED' && state !== 'PARTIAL_SUCCESS') return { outcome: 'pending' }
  const reason =
    destination?.errorInfo?.errorCounts?.[0]?.reason ?? 'PROCESSING_ERROR_REASON_UNSPECIFIED'
  // One event a request: a partial success has nothing else that succeeded.
  if (DONE_REASONS.has(reason)) return { outcome: 'done', reason }
  return { outcome: RETRY_REASONS.has(reason) ? 'retry' : 'failed', reason }
}

/**
 * Sign-ups from a Google ad whose conversion was never written (its write failed after the
 * attribution was kept, src/analytics.ts recordSignup): written now, at the user's creation,
 * as recordAdConversion would have. Within Google's 90 days only. How many.
 */
export async function recoverSignups(now = new Date()) {
  const since = new Date(now.getTime() - MAX_AGE_MS)
  return prisma.$executeRaw`
    INSERT INTO "AdConversion" ("id", "userId", "kind", "at", "sendAfter")
    SELECT gen_random_uuid()::text, u."id", 'sign_up', u."createdAt",
           u."createdAt" + make_interval(secs => ${FIRST_DELAY_MS / 1000}::double precision)
    FROM "User" u
    WHERE u."createdAt" > ${since}
      AND jsonb_typeof(u."attribution" -> 'adClick') = 'object'
      AND NOT EXISTS (
        SELECT 1 FROM "AdConversion" c WHERE c."userId" = u."id" AND c."kind" = 'sign_up'
      )
    ON CONFLICT ("userId", "kind") DO NOTHING`
}

/**
 * The `ad-conversions` job. First the requests Google took and has not said the outcome of:
 * confirmed, sent again later for a reason that may pass, or given up. Then the rows due, to
 * Google. A row Google refuses is given up with its error; any other failure stops the run, and
 * what is left waits for the next. Rows past Google's 90 days are given up.
 */
export async function sendAdConversions(now = new Date(), config = adsConfig()) {
  const result = { sent: 0, failed: 0, confirmed: 0, retried: 0, recovered: 0 }
  result.recovered = await recoverSignups(now)
  if (!config) return result
  const giveUp = async (id: string, error: string) => {
    result.failed++
    await prisma.adConversion.updateMany({
      where: { id, confirmedAt: null, failedAt: null },
      data: { failedAt: now, requestId: null, error: error.slice(0, 500) },
    })
  }
  const late = (at: Date) => now.getTime() - at.getTime() > MAX_AGE_MS
  const stop = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    noteFailure('google-ads', error instanceof Error ? error : new Error(message))
    return message
  }

  // What Google made of the requests it took.
  const taken = await prisma.adConversion.findMany({
    where: {
      requestId: { not: null },
      confirmedAt: null,
      failedAt: null,
      sentAt: { lte: new Date(now.getTime() - CHECK_AFTER_MS) },
    },
    orderBy: { sentAt: 'asc' },
    take: BATCH,
    select: { id: true, at: true, sentAt: true, requestId: true },
  })
  for (const row of taken) {
    let status: Status
    try {
      status = await statusOf(config, row.requestId!)
    } catch (error) {
      stop(error)
      return result
    }
    const where = { id: row.id, requestId: row.requestId, confirmedAt: null, failedAt: null }
    if (status.outcome === 'done') {
      result.confirmed++
      await prisma.adConversion.updateMany({
        where,
        data: { confirmedAt: now, requestId: null, error: status.reason ?? null },
      })
    } else if (status.outcome === 'failed') {
      await giveUp(row.id, status.reason!)
    } else if (
      status.outcome === 'retry' ||
      now.getTime() - row.sentAt!.getTime() > STALE_REQUEST_MS
    ) {
      if (late(row.at)) {
        await giveUp(row.id, status.reason ?? 'older than 90 days')
        continue
      }
      // Sent again later, under the same transactionId: Google counts it once.
      result.retried++
      await prisma.adConversion.updateMany({
        where,
        data: {
          requestId: null,
          sentAt: null,
          sendAfter: new Date(now.getTime() + RETRY_DELAY_MS),
          error: status.reason ?? 'no outcome from Google',
        },
      })
    }
  }

  // The rows due.
  const rows = await prisma.adConversion.findMany({
    where: { requestId: null, sentAt: null, failedAt: null, sendAfter: { lte: now } },
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
    if (late(row.at)) {
      await giveUp(row.id, 'older than 90 days')
      continue
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      await giveUp(row.id, 'too many attempts')
      continue
    }
    try {
      const requestId = await send(config, row, click)
      result.sent++
      await prisma.adConversion.updateMany({
        where: { id: row.id, sentAt: null, failedAt: null },
        // Without a request id there is nothing to check: taken as Google's answer says.
        data: {
          sentAt: now,
          requestId,
          attempts: { increment: 1 },
          ...(!requestId && { confirmedAt: now }),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await prisma.adConversion.updateMany({
        where: { id: row.id },
        data: { attempts: { increment: 1 }, error: message.slice(0, 500) },
      })
      if (error instanceof AdsError && error.rowsFault) {
        await giveUp(row.id, message)
        continue
      }
      // Not this row's fault: the run stops, and the next one tries again.
      stop(error)
      break
    }
  }
  return result
}
