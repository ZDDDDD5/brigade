// Meta sign-in for the Meta Ads App, on Brigade's own Meta app (META_APP_ID): Facebook Login for
// Business with a configuration (META_LOGIN_CONFIG_ID) that asks a user access token with
// ads_read, ads_management and business_management. Meta's official Ads MCP server
// (mcp.facebook.com/ads) registers only the clients it approved, so Brigade calls the Marketing
// API itself. The code is exchanged for a short token, then for a long-lived one (about 60 days):
// Meta gives no refresh token, so the account signs in again once it expires.
import { env } from '../config.js'

/** Graph API version. Meta keeps each about two years; move to the latest before then. */
export const GRAPH_VERSION = 'v27.0'
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`

/** A Meta user token, kept in the vault. expiresAt 0: Meta said it does not expire. */
export type MetaCredential = {
  accessToken: string
  expiresAt: number
  /** The Facebook user it was issued to (app-scoped id). */
  userId?: string
}

export const metaConfigured = () => Boolean(env.META_APP_ID && env.META_APP_SECRET)
export const metaRedirectUri = () => `${env.API_URL}/api/connections/oauth/meta/callback`

export function metaAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: env.META_APP_ID!,
    redirect_uri: metaRedirectUri(),
    response_type: 'code',
    state,
  })
  // Facebook Login for Business reads its permissions from the configuration; without one, the
  // classic dialog takes them as scopes.
  if (env.META_LOGIN_CONFIG_ID) params.set('config_id', env.META_LOGIN_CONFIG_ID)
  else params.set('scope', 'ads_read,ads_management,business_management')
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`
}

type TokenReply = {
  access_token?: string
  expires_in?: number
  error?: { message?: string; type?: string; code?: number }
}

async function tokenRequest(params: Record<string, string>): Promise<MetaCredential> {
  // A POST, so the app secret and the code never sit in a URL that a log could keep.
  const response = await fetch(`${GRAPH}/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.META_APP_ID!,
      client_secret: env.META_APP_SECRET!,
      ...params,
    }),
  })
  const data = (await response.json().catch(() => ({}))) as TokenReply
  if (!response.ok || !data.access_token)
    throw new Error(`Meta sign-in failed: ${data.error?.message ?? response.status}`)
  return {
    accessToken: data.access_token,
    // No expires_in: a token that does not expire (Meta says so for some business tokens).
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
  }
}

/** The code from the dialog, as a long-lived user token. */
export async function exchangeMetaCode(code: string): Promise<MetaCredential> {
  const short = await tokenRequest({ code, redirect_uri: metaRedirectUri() })
  try {
    return await tokenRequest({
      grant_type: 'fb_exchange_token',
      fb_exchange_token: short.accessToken,
    })
  } catch (error) {
    // The short token still works for an hour or two; keep it rather than fail the sign-in.
    console.error('meta long-lived exchange failed:', error instanceof Error ? error.message : error)
    return short
  }
}

/** Who signed in: the Facebook user's name, which names the account's row. */
export async function metaAccount(accessToken: string) {
  const response = await fetch(`${GRAPH}/me?fields=id,name`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const me = (await response.json().catch(() => ({}))) as { id?: string; name?: string }
  return { id: me.id ?? null, name: me.name ?? null }
}

/** Whether a Graph API error says the token no longer works (OAuthException 190, or 102). */
export const tokenRefused = (status: number, body: unknown) => {
  const code = (body as { error?: { code?: number } } | null)?.error?.code
  return status === 401 || code === 190 || code === 102
}
