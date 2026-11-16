// Pi (@ai-sdk/harness-pi), behind the pi_harness feature (docs/harnesses.md): a harness that runs
// inside the runner, rather than as a vendor CLI of its own, and calls the model's vendor itself on
// the login already on the computer: a Claude login for Claude's models, a ChatGPT one for GPT's
// (loginOf). Its file tools and shell go through the thread's sandbox, as the teammate's own user.
//
// Logins rotate their refresh token at each refresh, the previous one dying then: if Pi refreshed
// on its own, Claude Code or Codex on the same login would be signed out, and Brigade's backup of
// the login (account-backups.ts) would keep a dead copy. So Pi never refreshes and never writes a
// login. Before each request it reads the access token the login holds now (loginCredentials):
// - Claude: on a cloud computer, the account's long-lived token from `claude setup-token`, which
//   never refreshes; elsewhere the access token in Claude Code's own credentials file. One that
//   expired is refreshed by Claude Code's next turn, not by Pi: Pi's turn fails, saying so.
// - Codex: the access token in its auth.json. One about to expire is refreshed by Codex itself
//   (refreshCodexLogin, a `codex app-server` asked `account/read` with refreshToken), then read
//   again.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PiCredentialStore } from '@ai-sdk/harness-pi'
import { type AccountRef, type Effort, type ThreadSkill, SKILL_ENTRY } from '@brigade/contracts'
import { accountDir, accountToken } from '../accounts.js'
import { refreshCodexLogin } from '../codex-usage.js'
import type { PiPackage } from '../pi-package.js'

type Credential = NonNullable<Awaited<ReturnType<PiCredentialStore['read']>>>

/** Pi's provider for a login: Anthropic's API, or the ChatGPT backend Codex uses. */
export const PI_PROVIDER = { claude_code: 'anthropic', codex: 'openai-codex' } as const

/** How long a token must still hold for a request to go out on it, as Pi itself asks (5 min). */
const VALID_MS = 5 * 60_000

/** Why a turn on Pi cannot read its login, said to the person through the turn's error. */
export class PiLoginError extends Error {}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** A JWT's expiry, in ms, without checking it: the token is the login's own. */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  const claims = record(parse(Buffer.from(payload, 'base64url').toString('utf8')))
  return typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined
}

/** The ChatGPT account a Codex access token is for, which the backend wants beside it. */
function chatgptAccount(token: string): string | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  const claims = record(parse(Buffer.from(payload, 'base64url').toString('utf8')))
  const auth = record(claims?.['https://api.openai.com/auth'])
  return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined
}

/** Where a login's files are: Brigade's folder for the account, else the CLI's own. */
function loginDir(account: AccountRef, env: NodeJS.ProcessEnv, home: string) {
  const dir = accountDir(account)
  if (dir) return dir
  return account.provider === 'codex'
    ? (env.CODEX_HOME ?? join(home, '.codex'))
    : (env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'))
}

export type LoginReadOptions = {
  /** Has the login's own CLI refresh it (Codex's), resolved once its file holds the new tokens. */
  refresh?: (account: AccountRef) => Promise<void>
  now?: () => number
  env?: NodeJS.ProcessEnv
  home?: string
  /** The account's long-lived Claude token, if it has one (accountToken). */
  claudeToken?: (account: AccountRef) => string | undefined
}

/**
 * The login's credential for Pi, as it is now, or undefined for a provider it is not. Never its
 * refresh token: Pi has nothing to refresh with.
 */
async function readLogin(
  account: AccountRef,
  providerId: string,
  options: LoginReadOptions,
): Promise<Credential | undefined> {
  if (providerId !== PI_PROVIDER[account.provider]) return undefined
  const now = options.now?.() ?? Date.now()
  const dir = loginDir(account, options.env ?? process.env, options.home ?? homedir())
  if (account.provider === 'claude_code') {
    // A long-lived token (cloud computers): Pi sends it as Claude Code does, with its headers.
    const token = (options.claudeToken ?? defaultClaudeToken)(account)
    if (token) return { type: 'api_key', key: token }
    const file = record(
      parse(await readFile(join(dir, '.credentials.json'), 'utf8').catch(() => '')),
    )
    const oauth = record(file?.claudeAiOauth)
    const access = typeof oauth?.accessToken === 'string' ? oauth.accessToken : undefined
    if (!access)
      throw new PiLoginError(
        'Pi found no Claude login to run on: sign in to this Claude account again under Accounts.',
      )
    const expires = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined
    if (expires !== undefined && expires - now < VALID_MS)
      throw new PiLoginError(
        'The Claude login’s access token has expired. Claude Code refreshes it on its next turn on this account; Pi never does, so that Claude Code stays signed in. Try again after a Claude Code turn.',
      )
    // An api_key credential: Pi uses it as it is, and never tries to refresh it.
    return { type: 'api_key', key: access }
  }
  const auth = record(parse(await readFile(join(dir, 'auth.json'), 'utf8').catch(() => '')))
  const tokens = record(auth?.tokens)
  const access = typeof tokens?.access_token === 'string' ? tokens.access_token : undefined
  if (!access)
    throw new PiLoginError(
      'Pi found no ChatGPT login to run on: sign in to this Codex account again under Accounts.',
    )
  const accountId =
    (typeof tokens?.account_id === 'string' ? tokens.account_id : undefined) ??
    chatgptAccount(access)
  return {
    type: 'oauth',
    access,
    // Pi refreshes only through modify (loginCredentials), which never runs its refresh.
    refresh: '',
    expires: jwtExpiry(access) ?? now + VALID_MS * 2,
    ...(accountId ? { accountId } : {}),
  }
}

const defaultClaudeToken = (account: AccountRef) => accountToken(account).CLAUDE_CODE_OAUTH_TOKEN

/**
 * Pi's credential store on a login: reads it as it is now at each request, and writes nothing.
 * Pi refreshes an OAuth credential inside `modify`; here the login's own CLI refreshes it instead
 * (Codex's, by `refresh`), and Pi's refresh is never run. Without one, Pi's request fails, saying
 * why, rather than spend the login's refresh token.
 */
export function loginCredentials(
  account: AccountRef,
  options: LoginReadOptions = {},
): PiCredentialStore {
  const refresh = options.refresh ?? refreshCodexLogin
  return {
    read: (providerId) => readLogin(account, providerId, options),
    async list() {
      const providerId = PI_PROVIDER[account.provider]
      const credential = await readLogin(account, providerId, options).catch(() => undefined)
      return credential ? [{ providerId, type: credential.type }] : []
    },
    async modify(providerId) {
      const current = await readLogin(account, providerId, options)
      if (current?.type !== 'oauth') return current
      const now = options.now?.() ?? Date.now()
      if (current.expires - now >= VALID_MS) return current
      // Codex refreshes it (or already did, for another turn): Pi takes what it wrote.
      await refresh(account).catch((error: unknown) => {
        throw new PiLoginError(
          `Codex could not refresh this ChatGPT login (${error instanceof Error ? error.message : String(error)}). Sign in to it again under Accounts if it keeps failing.`,
        )
      })
      const after = await readLogin(account, providerId, options)
      if (after?.type === 'oauth' && after.expires - (options.now?.() ?? Date.now()) < VALID_MS)
        throw new PiLoginError(
          'This ChatGPT login’s access token is still expired after Codex refreshed it. Sign in to it again under Accounts.',
        )
      return after
    },
    // Signing out is the login's own CLI's, from Accounts.
    async delete() {},
  }
}

/** Pi's model reference: the provider of the teammate's login, so Pi never picks another one. */
export const piModel = (account: AccountRef, model: string) =>
  `${PI_PROVIDER[account.provider]}/${model}`

/** Brigade's skills as Pi lists them: written in the thread's `.agents/skills` (skills.ts). */
export const piSkills = (workDir: string, skills: Pick<ThreadSkill, 'name' | 'description'>[]) =>
  skills
    .filter((skill) => /^[a-z0-9][a-z0-9-]*$/.test(skill.name))
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: join(workDir, '.agents', 'skills', skill.name, SKILL_ENTRY),
    }))

/**
 * The Pi harness for a turn on `account`. Brigade's own tools reach it as the agent's tools, its MCP
 * servers (the teammate's browser) through Pi's own MCP client, which names their tools as Claude
 * Code does (`mcp__browser__browser_click`), and its skills as Pi's resources.
 */
export function createPiHarness(input: {
  /** Pi's package (loadPi): the runner installs it on first use, not in its bundle. */
  pi: PiPackage
  account: AccountRef
  effort: Effort | undefined
  mcpServers: Record<string, unknown>
  skills: ReturnType<typeof piSkills>
  /** Tests: another store, and providers' addresses (a local server for the vendor's API). */
  credentials?: PiCredentialStore
  providers?: Parameters<PiPackage['createPi']>[0] extends infer S
    ? S extends { providers?: infer P }
      ? P
      : never
    : never
}) {
  return input.pi.createPi({
    // An empty record: no key from the runner's own environment, only the login's (credentials).
    auth: {},
    credentials: input.credentials ?? loginCredentials(input.account),
    mcpServers: input.mcpServers,
    resources: { skills: input.skills },
    ...(input.effort ? { thinkingLevel: input.effort } : {}),
    ...(input.providers ? { providers: input.providers } : {}),
  })
}
