import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// Which client Brigade signs in to an MCP server as, against a real database (the local one
// of apps/api/.env; skipped without one). The provider is played by a fake fetch, answering as
// Vercel's does: dynamic client registration refused for an unapproved redirect URI, and a
// client ID metadata document accepted.
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
// A metadata document is only served over HTTPS.
process.env.API_URL = 'https://api.brigade.test'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select 1 from "McpClient" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { exchangeMcpCode, mcpAuthUrl, mcpClientDocumentUrl } =
  await import('../src/connectors/mcp.js')

const realFetch = globalThis.fetch
const AUTH = 'https://auth.vercel.test'
let documentSupported = true
let registrations = 0
/** Whether Vercel approves the next registration, as it might once it reviews Brigade. */
let approved = false
/** The client IDs the token endpoint was asked as. */
let exchangedAs: string[] = []
/** The secret a registration gives, if any, and those the token endpoint was sent. */
let issuedSecret: string | undefined
let secretsSent: (string | null)[] = []

before(() => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.href.includes('/.well-known/oauth-protected-resource'))
      return json({ resource: 'https://mcp.vercel.test/', authorization_servers: [AUTH] })
    if (url.origin === AUTH && url.pathname.includes('.well-known'))
      return json({
        issuer: AUTH,
        authorization_endpoint: `${AUTH}/oauth/authorize`,
        token_endpoint: `${AUTH}/oauth/token`,
        registration_endpoint: `${AUTH}/oauth/register`,
        scopes_supported: ['openid', 'email', 'offline_access', 'profile'],
        client_id_metadata_document_supported: documentSupported,
      })
    if (url.origin === AUTH && url.pathname === '/oauth/register') {
      registrations++
      if (approved)
        return json(
          { client_id: 'registered-client', ...(issuedSecret && { client_secret: issuedSecret }) },
          201,
        )
      return json(
        {
          error: 'invalid_redirect_uri',
          error_description:
            'The provided redirect URIs are not approved for use by this authorization server.',
        },
        400,
      )
    }
    if (url.origin === AUTH && url.pathname === '/oauth/token') {
      const form = new URLSearchParams(String(init.body))
      exchangedAs.push(form.get('client_id') ?? '')
      secretsSent.push(form.get('client_secret'))
      return json({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600 })
    }
    return new Response(null, { status: 401 })
  }) as typeof fetch
})

const forget = async () => {
  if (skip) return
  const { prisma } = await import('../src/db.js')
  await prisma.mcpClient.deleteMany({ where: { issuer: AUTH } })
}
before(forget)
after(async () => {
  globalThis.fetch = realFetch
  await forget()
})

const server = { url: 'https://mcp.vercel.test', tools: {} }

test(
  'registering refused: Brigade signs in with its client ID metadata document',
  { skip },
  async () => {
    documentSupported = true
    registrations = 0
    const signIn = await mcpAuthUrl(server, 'state', 'verifier')
    assert.equal(signIn.clientId, mcpClientDocumentUrl())
    const url = new URL(signIn.url)
    assert.equal(url.origin + url.pathname, `${AUTH}/oauth/authorize`)
    assert.equal(url.searchParams.get('client_id'), mcpClientDocumentUrl())
    assert.equal(registrations, 1)
    // Nothing kept: the next sign-in asks to register again, in case the provider approved it.
    await mcpAuthUrl(server, 'state', 'verifier')
    assert.equal(registrations, 2)
  },
)

test('registering refused and no metadata document: the error says so', { skip }, async () => {
  documentSupported = false
  await assert.rejects(mcpAuthUrl(server, 'state', 'verifier'), /not approved/)
})

test(
  'registering approved mid sign-in: the code is exchanged as the client it was issued to',
  { skip },
  async () => {
    documentSupported = true
    approved = false
    exchangedAs = []
    const signIn = await mcpAuthUrl(server, 'state', 'verifier')
    assert.equal(signIn.clientId, mcpClientDocumentUrl())
    // The person signs in meanwhile, and the provider now registers Brigade.
    approved = true
    const { credential } = await exchangeMcpCode(
      server,
      'code',
      'verifier',
      undefined,
      signIn.clientId,
    )
    assert.deepEqual(exchangedAs, [mcpClientDocumentUrl()])
    assert.equal(credential.clientId, mcpClientDocumentUrl())
    // The next sign-in registers, and its code is exchanged as the registered client.
    const next = await mcpAuthUrl(server, 'state', 'verifier')
    assert.equal(next.clientId, 'registered-client')
    await exchangeMcpCode(server, 'code', 'verifier', undefined, next.clientId)
    assert.deepEqual(exchangedAs, [mcpClientDocumentUrl(), 'registered-client'])
    approved = false
  },
)

test('a client secret the server gives is kept sealed, and signs in', { skip }, async () => {
  const { prisma } = await import('../src/db.js')
  await forget()
  documentSupported = true
  approved = true
  issuedSecret = 'the-registration-secret'
  secretsSent = []
  try {
    const signIn = await mcpAuthUrl(server, 'state', 'verifier')
    assert.equal(signIn.clientId, 'registered-client')
    const row = await prisma.mcpClient.findFirstOrThrow({ where: { issuer: AUTH } })
    // Kept in plain text too, for an API from before clientSealed, until the next deploy.
    assert.equal(row.clientSecret, issuedSecret)
    assert.ok(row.clientSealed)
    assert.ok(!row.clientSealed.includes(issuedSecret))
    assert.ok(!Buffer.from(row.clientSealed, 'utf8').toString().includes('registration-secret'))
    const { credential } = await exchangeMcpCode(server, 'code', 'v', undefined, signIn.clientId)
    assert.deepEqual(secretsSent, ['the-registration-secret'])
    assert.equal(credential.clientSecret, 'the-registration-secret')
  } finally {
    approved = false
    issuedSecret = undefined
  }
})

test('a secret kept in plain text before is read, then sealed by the job', { skip }, async () => {
  const { prisma } = await import('../src/db.js')
  const { mcpRedirectUri, sealMcpClients } = await import('../src/connectors/mcp.js')
  await forget()
  await prisma.mcpClient.create({
    data: {
      issuer: AUTH,
      redirectUri: mcpRedirectUri(),
      clientId: 'old-client',
      clientSecret: 'old-plain-secret',
    },
  })
  secretsSent = []
  const signIn = await mcpAuthUrl(server, 'state', 'verifier')
  assert.equal(signIn.clientId, 'old-client')
  await exchangeMcpCode(server, 'code', 'verifier', undefined, signIn.clientId)
  assert.deepEqual(secretsSent, ['old-plain-secret'])
  // Reading it changes nothing: an API from before clientSealed may still read the row.
  let row = await prisma.mcpClient.findFirstOrThrow({ where: { issuer: AUTH } })
  assert.equal(row.clientSecret, 'old-plain-secret')
  assert.equal(row.clientSealed, null)

  assert.ok((await sealMcpClients()) >= 1)
  row = await prisma.mcpClient.findFirstOrThrow({ where: { issuer: AUTH } })
  assert.ok(row.clientSealed && !row.clientSealed.includes('old-plain-secret'))
  const sealed = row.clientSealed
  await sealMcpClients()
  row = await prisma.mcpClient.findFirstOrThrow({ where: { issuer: AUTH } })
  assert.equal(row.clientSealed, sealed, 'a sealed row is left as it is')

  // Once the plain text is cleared (the next deploy), the sealed copy signs in alone.
  await prisma.mcpClient.update({ where: { id: row.id }, data: { clientSecret: null } })
  secretsSent = []
  const again = await mcpAuthUrl(server, 'state', 'verifier')
  await exchangeMcpCode(server, 'code', 'verifier', undefined, again.clientId)
  assert.deepEqual(secretsSent, ['old-plain-secret'])
})

test('a sealed secret opens only for the row it was sealed for', async () => {
  const { openShared, sealShared } = await import('../src/vault.js')
  const sealed = sealShared('mcp-client', 'https://a.test\nhttps://cb', 'secret')
  assert.equal(openShared('mcp-client', 'https://a.test\nhttps://cb', sealed), 'secret')
  assert.throws(() => openShared('mcp-client', 'https://b.test\nhttps://cb', sealed))
  assert.throws(() => openShared('another-purpose', 'https://a.test\nhttps://cb', sealed))
})
