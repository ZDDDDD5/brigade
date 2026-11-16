import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AccountRef } from '@brigade/contracts'
import { jwtExpiry, loginCredentials, PiLoginError, piModel } from '../src/harness/pi.js'

// Pi on a login already on the computer (harness/pi.ts): it reads the token the login holds now,
// before each request, and never refreshes or writes it, so Claude Code and Codex on the same
// login stay signed in, and Brigade's backup of the login stays the live one.

const claude: AccountRef = { id: 'acc-c', provider: 'claude_code', source: 'machine' }
const codex: AccountRef = { id: 'acc-x', provider: 'codex', source: 'machine' }

const jwt = (claims: object) =>
  ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

const codexAccess = (expiresAt: number) =>
  jwt({
    exp: Math.floor(expiresAt / 1000),
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
  })

async function codexLogin(dir: string, access: string, refresh: string) {
  await writeFile(
    join(dir, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'id',
        access_token: access,
        refresh_token: refresh,
        account_id: 'acct-123',
      },
      last_refresh: new Date().toISOString(),
    }),
  )
}

/** Pi's refresh: what Models would run inside modify. Here it must never run. */
const piRefresh = async () => {
  throw new Error('Pi refreshed the login itself')
}

test('on a cloud computer, a Claude account’s long-lived token goes out as it is', async () => {
  const store = loginCredentials(claude, { claudeToken: () => 'sk-ant-oat01-setup-token' })
  assert.deepEqual(await store.read('anthropic'), {
    type: 'api_key',
    key: 'sk-ant-oat01-setup-token',
  })
  // Not a provider of this login.
  assert.equal(await store.read('openai-codex'), undefined)
  assert.deepEqual(await store.list(), [{ providerId: 'anthropic', type: 'api_key' }])
})

test('a Claude login is read again at each request, and an expired one is left to Claude Code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-login-'))
  const options = { env: { CLAUDE_CONFIG_DIR: dir }, claudeToken: () => undefined }
  const store = loginCredentials(claude, options)
  const write = (accessToken: string, expiresAt: number) =>
    writeFile(
      join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'sk-ant-ort01-r', expiresAt } }),
    )
  await write('sk-ant-oat01-a', Date.now() + 3600_000)
  // An api_key credential: Pi has no refresh token, nor a reason to refresh.
  assert.deepEqual(await store.read('anthropic'), { type: 'api_key', key: 'sk-ant-oat01-a' })
  await write('sk-ant-oat01-b', Date.now() + 3600_000)
  assert.deepEqual(await store.read('anthropic'), { type: 'api_key', key: 'sk-ant-oat01-b' })
  // Expired: Pi's request fails, saying Claude Code refreshes it; nothing is written.
  await write('sk-ant-oat01-c', Date.now() - 1000)
  const before = await readFile(join(dir, '.credentials.json'), 'utf8')
  await assert.rejects(store.read('anthropic'), PiLoginError)
  assert.equal(await readFile(join(dir, '.credentials.json'), 'utf8'), before)
  await rm(dir, { recursive: true, force: true })
})

test('Pi never holds a Codex login’s refresh token, and Codex refreshes it, not Pi', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-login-'))
  let now = Date.now()
  const refreshed: AccountRef[] = []
  const store = loginCredentials(codex, {
    env: { CODEX_HOME: dir },
    now: () => now,
    // Codex's own refresh (refreshCodexLogin): it writes the new tokens in auth.json.
    refresh: async (account) => {
      refreshed.push(account)
      await codexLogin(dir, codexAccess(now + 10 * 86_400_000), 'rt-two')
    },
  })
  await codexLogin(dir, codexAccess(now + 3600_000), 'rt-one')
  const first = await store.read('openai-codex')
  assert.equal(first?.type, 'oauth')
  assert.equal((first as { refresh: string }).refresh, '')
  assert.equal((first as { accountId?: string }).accountId, 'acct-123')
  // Still valid: Pi's modify returns it untouched, and its refresh never runs.
  assert.deepEqual(await store.modify('openai-codex', piRefresh), first)
  assert.equal(refreshed.length, 0)
  // About to expire: Codex refreshes it, Pi takes what Codex wrote.
  now += 3600_000 - 60_000
  const after = await store.modify('openai-codex', piRefresh)
  assert.deepEqual(refreshed, [codex])
  assert.equal(after?.type, 'oauth')
  assert.ok((after as { expires: number }).expires > now + 86_400_000)
  const login = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
  assert.equal(login.tokens.refresh_token, 'rt-two')
  await rm(dir, { recursive: true, force: true })
})

test('a Codex refresh that fails, or leaves the token expired, fails the request without Pi’s own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-login-'))
  const now = Date.now()
  await codexLogin(dir, codexAccess(now - 1000), 'rt-one')
  const failing = loginCredentials(codex, {
    env: { CODEX_HOME: dir },
    refresh: async () => {
      throw new Error('signed out')
    },
  })
  await assert.rejects(failing.modify('openai-codex', piRefresh), /Codex could not refresh/)
  const stale = loginCredentials(codex, { env: { CODEX_HOME: dir }, refresh: async () => {} })
  await assert.rejects(stale.modify('openai-codex', piRefresh), /still expired/)
  await rm(dir, { recursive: true, force: true })
})

test('a login without its file says to sign in again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-login-'))
  const store = loginCredentials(codex, { env: { CODEX_HOME: dir } })
  await assert.rejects(store.read('openai-codex'), /sign in to this Codex account again/)
  assert.deepEqual(await store.list(), [])
  await rm(dir, { recursive: true, force: true })
})

test('the model goes under its login’s own provider, and a JWT’s expiry is read', () => {
  assert.equal(piModel(claude, 'claude-opus-5-5'), 'anthropic/claude-opus-5-5')
  assert.equal(piModel(codex, 'gpt-6.1-sol'), 'openai-codex/gpt-6.1-sol')
  assert.equal(jwtExpiry(jwt({ exp: 1_800_000_000 })), 1_800_000_000_000)
  assert.equal(jwtExpiry('not-a-jwt'), undefined)
})
