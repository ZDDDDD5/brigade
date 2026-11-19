// Harness logins on this computer. Brigade runs the vendor's own login command
// into a config directory per account, and never reads what it writes there,
// with one exception. On a workspace computer several teammate users share a
// Claude account, and Claude's own login refreshes by rotating its refresh
// token, so the first teammate to refresh would sign the others out. There a
// Claude account is a long-lived token from `claude setup-token`, which the
// runner keeps beside the config directory and hands to each turn.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AccountRef } from '@brigade/contracts'
import xterm from '@xterm/headless'
import { ACCOUNTS_DIR, CLOUD } from './config.js'
import { installAgy, keepLogin, machineAgyLogin } from './harness/antigravity.js'
import { shareAccount } from './teammates.js'
import { harnessEnv } from './harness/env.js'
import { vendorCli, type Vendor } from './vendor-cli.js'
import { WINDOWS } from './windows.js'

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const LOGIN_TIMEOUT_MS = 15 * 60_000
/** Where a Claude account's token lives, readable only by the runner. */
const TOKEN_FILE = '.oauth-token'
const TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/
const AUTHORIZE_URL = /https:\/\/\S+\/oauth\/authorize\?\S+/
/** Google's sign-in page, as Antigravity's `agy acp --login` prints it. */
const GOOGLE_AUTH_URL = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?\S+/
/** setup-token's pseudo-terminal: wide enough that its URL and token stay on one line. */
const COLS = 1000
const ROWS = 50

/** The config directory of a Brigade-signed-in account; null for the machine's own login. */
export function accountDir(account: AccountRef): string | null {
  if (account.source === 'machine') return null
  if (!SAFE_ID.test(account.id)) throw new Error('Invalid account id')
  return join(ACCOUNTS_DIR, account.id)
}

/** The account's config directory, as the vendor CLI expects it. */
function configEnv(account: AccountRef): Record<string, string> {
  const dir = accountDir(account)
  if (!dir) return {}
  // Antigravity's folder is given per turn, with its login copied there (harness/antigravity.ts).
  if (account.provider === 'antigravity') return {}
  return account.provider === 'codex' ? { CODEX_HOME: dir } : { CLAUDE_CONFIG_DIR: dir }
}

/**
 * A Claude account's long-lived token, for a turn on it. None when its login
 * is in the config directory (a member's machine, or signed in before tokens).
 */
export function accountToken(account: AccountRef): Record<string, string> {
  const dir = accountDir(account)
  if (!dir || account.provider === 'codex' || account.provider === 'antigravity') return {}
  try {
    const token = readFileSync(join(dir, TOKEN_FILE), 'utf8').trim()
    return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}
  } catch {
    return {}
  }
}

/** Environment that points a harness at the account's login. */
export function accountEnv(account: AccountRef): Record<string, string> {
  return { ...configEnv(account), ...accountToken(account) }
}

/** Terminal output as text: links and colours dropped, cursor moves kept as spaces and line breaks. */
const strip = (text: string) =>
  text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC: hyperlinks, titles
    .replace(/\x1b\[(\d*)C/g, (_, n: string) => ' '.repeat(Math.min(Number(n) || 1, 200)))
    .replace(/\x1b\[[0-9;?]*[ABEFGHJKdf]/g, '\n')
    .replace(/\x1b\[[0-9;?<=>]*[A-Za-z]/g, '') // colours and modes
    .replace(/\x1b[78]/g, '')
    .replace(/\r/g, '')

/** Never let a token reach an error message. */
const redact = (text: string) => text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[token]')

/**
 * A terminal UI's screen, rebuilt from its output. It redraws only the cells
 * that change, so its text cannot be read from the output itself.
 */
class Screen {
  // Reading the buffer is a "proposed" API in the headless build.
  private term = new xterm.Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 1000,
    allowProposedApi: true,
  })
  private writing = Promise.resolve()

  write(data: Uint8Array) {
    this.writing = this.writing.then(() => new Promise<void>((done) => this.term.write(data, done)))
  }

  /** Its lines, once everything written so far is drawn. */
  async lines() {
    await this.writing
    const buffer = this.term.buffer.active
    return Array.from(
      { length: buffer.length },
      (_, i) => buffer.getLine(i)?.translateToString(true).trim() ?? '',
    )
  }
}

/** The first match of a pattern on any line. */
const find = (lines: string[], pattern: RegExp) =>
  lines.map((line) => line.match(pattern)).find(Boolean)

type Prompt = { url: string; userCode?: string; flow: 'paste' | 'device' }
type Done = { ok: boolean; error?: string; email?: string; plan?: string }

/** One running vendor login. */
class Login {
  private child: ChildProcess
  private raw = ''
  private prompted = false
  /** Signing in for a token (a Claude account on a workspace computer): its screen. */
  private readonly screen: Screen | undefined
  private quiet: NodeJS.Timeout | undefined
  private due: NodeJS.Timeout | undefined
  private token: string | undefined
  private timer: NodeJS.Timeout

  constructor(
    readonly account: AccountRef,
    private readonly dir: string,
    private readonly onPrompt: (prompt: Prompt) => void,
    private readonly onDone: (done: Done) => void,
    /** The vendor CLI: its program and first arguments (vendor-cli.ts). */
    cli: [string, string[]],
  ) {
    if (account.provider !== 'codex' && account.provider !== 'antigravity' && CLOUD)
      this.screen = new Screen()
    const [command, args]: [string, string[]] =
      account.provider === 'antigravity'
        ? // Google's sign-in by a pasted code, into the account's folder (kept by keepLogin).
          [
            cli[0],
            [
              ...cli[1],
              'acp',
              '--login',
              '--disable-telemetry',
              '--gemini-dir',
              join(dir, '.gemini'),
            ],
          ]
        : account.provider === 'codex'
          ? [cli[0], [...cli[1], 'login', '--device-auth']]
          : this.screen
            ? // A terminal UI, so in a pseudo-terminal.
              [
                'script',
                ['-qefc', `stty cols ${COLS} rows ${ROWS}; exec claude setup-token`, '/dev/null'],
              ]
            : [cli[0], [...cli[1], 'auth', 'login', '--claudeai']]
    this.child = spawn(command, args, {
      env: harnessEnv({
        ...configEnv(account),
        BROWSER: 'false',
        ...(account.provider === 'antigravity' ? { AGY_CLI_DISABLE_AUTO_UPDATE: '1' } : {}),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stdout!.on('data', (d) => this.read(d))
    this.child.stderr!.on('data', (d) => this.read(d))
    this.child.on('error', (error) =>
      this.finish({ ok: false, error: `Could not run ${command}: ${error.message}` }),
    )
    this.child.on('close', (code) => void this.closed(code))
    this.timer = setTimeout(() => this.cancel('Sign-in timed out'), LOGIN_TIMEOUT_MS)
  }

  /** Pass the code from the vendor's page to the login command. Never stored. */
  submit(code: string) {
    const clean = code.replace(/\s+/g, '')
    if (!this.screen) {
      this.child.stdin?.write(clean + '\n')
      return
    }
    // The terminal UI takes the code as typed text, then Enter on its own.
    this.child.stdin?.write(clean)
    setTimeout(() => this.child.stdin?.write('\r'), 300)
  }

  /** Stop it. A sign-in that gives way to a newer one leaves the directory to it. */
  cancel(reason = 'Cancelled', keepDir = false) {
    this.child.kill()
    this.finish({ ok: false, error: reason }, keepDir)
  }

  private read(chunk: Buffer) {
    if (this.screen) {
      this.screen.write(chunk)
      // Look once it holds still (a line may be half drawn before), or every few seconds while it animates.
      clearTimeout(this.quiet)
      this.quiet = setTimeout(() => void this.look(), 400)
      this.due ??= setTimeout(() => void this.look(), 3000)
      return
    }
    this.raw = (this.raw + chunk.toString()).slice(-16000)
    if (this.prompted) return
    const output = strip(this.raw)
    if (this.account.provider === 'antigravity') {
      const url = output.match(GOOGLE_AUTH_URL)?.[0]
      if (url) {
        this.prompted = true
        this.onPrompt({ url, flow: 'paste' })
      }
    } else if (this.account.provider === 'codex') {
      const url = output.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0]
      const code = output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/)?.[0]
      if (url && code) {
        this.prompted = true
        this.onPrompt({ url, userCode: code, flow: 'device' })
      }
    } else {
      const url = output.match(AUTHORIZE_URL)?.[0]
      if (url) {
        this.prompted = true
        this.onPrompt({ url, flow: 'paste' })
      }
    }
  }

  /** What setup-token shows: its sign-in URL, then the token, or an error. */
  private async look() {
    clearTimeout(this.quiet)
    clearTimeout(this.due)
    this.due = undefined
    if (this.finished || !this.screen) return
    const lines = await this.screen.lines()
    if (this.finished) return
    // A failed step (often a wrong or expired code) waits for Enter to retry: stop here instead.
    const error = find(lines, /OAuth error: *(.+)/)?.[1]
    if (error) return this.cancel(redact(`Claude sign-in failed: ${error}`).slice(0, 300))
    if (!this.prompted) {
      const url = find(lines, AUTHORIZE_URL)?.[0]
      if (url) {
        this.prompted = true
        this.onPrompt({ url, flow: 'paste' })
      }
      return
    }
    const token = find(lines, TOKEN)?.[0]
    if (token && !this.token) {
      this.token = token
      // It shows the token and exits; stop it if it lingers.
      setTimeout(() => this.child.kill(), 3000)
    }
  }

  private async closed(code: number | null) {
    if (this.finished) return
    if (this.screen) {
      const lines = await this.screen.lines()
      this.token ??= find(lines, TOKEN)?.[0]
      if (this.finished) return
      if (!this.token) {
        const last = lines.filter(Boolean).at(-1) ?? 'Sign-in failed'
        return this.finish({ ok: false, error: redact(last).slice(0, 300) })
      }
      try {
        await this.saveToken(this.token)
      } catch (error) {
        return this.finish({ ok: false, error: `Could not save the sign-in: ${String(error)}` })
      }
      // Inference-only: it cannot tell who it belongs to.
      return this.finish({ ok: true })
    }
    if (code !== 0) return this.finish({ ok: false, error: this.lastLine() })
    if (this.account.provider === 'antigravity') {
      // Its one login file, the runner's alone: each turn copies it where it runs.
      try {
        return this.finish({ ok: true, ...(await keepLogin(this.dir)) })
      } catch (error) {
        return this.finish({ ok: false, error: `Could not save the sign-in: ${String(error)}` })
      }
    }
    if (CLOUD) await shareAccount(this.account.id)
    this.finish({ ok: true, ...(await identity(this.account)) })
  }

  /** Only the runner can read it; a login from before tokens is removed. */
  private async saveToken(token: string) {
    const file = join(this.dir, TOKEN_FILE)
    await writeFile(file, token + '\n', { mode: 0o600 })
    await chmod(file, 0o600)
    await rm(join(this.dir, '.credentials.json'), { force: true })
  }

  private lastLine() {
    const last = strip(this.raw)
      .split('\n')
      .filter((l) => l.trim())
      .at(-1)
    return redact(last?.trim() ?? 'Sign-in failed').slice(0, 300)
  }

  private finished = false
  private finish(done: Done, keepDir = false) {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer)
    clearTimeout(this.quiet)
    clearTimeout(this.due)
    this.onDone(done)
    if (!done.ok && !keepDir) void rm(this.dir, { recursive: true, force: true })
  }
}

/** Who the account is signed in as, from the CLI's own status command. Never the credential. */
async function identity(account: AccountRef): Promise<{ email?: string; plan?: string }> {
  if (account.provider === 'codex' || account.provider === 'antigravity') return {}
  const out = await run('claude', ['auth', 'status', '--json'], configEnv(account))
  if (out === undefined) return {}
  try {
    const status = JSON.parse(out) as {
      loggedIn?: boolean
      email?: string
      subscriptionType?: string
    }
    return {
      ...(status.email ? { email: status.email } : {}),
      ...(status.subscriptionType ? { plan: status.subscriptionType } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Where the person's own login lives when their CLI is not on this computer for Brigade to ask
 * (Windows: vendor-cli.ts), so only whether it exists is known. Never read.
 */
const loginFile = (vendor: Vendor, home = homedir()) =>
  vendor === 'codex'
    ? join(process.env.CODEX_HOME ?? join(home, '.codex'), 'auth.json')
    : join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), '.credentials.json')

/**
 * Whether this machine's own logins exist, for the accounts already on a member's machine: a
 * Claude Code or Codex the person signed in to is used as it is, without asking them to sign in
 * again. Its CLI says so; on Windows without that CLI (a connection never downloads it), its
 * login file does, and the turn's own copy of the CLI signs in with it.
 */
export async function machineLogins(home = homedir()): Promise<
  {
    provider: 'claude_code' | 'codex' | 'antigravity'
    loggedIn: boolean
    email?: string
    plan?: string
  }[]
> {
  const fileOnly = async (vendor: Vendor) =>
    WINDOWS && !(await vendorCli(vendor)) ? existsSync(loginFile(vendor, home)) : undefined
  type ClaudeStatus = { loggedIn?: boolean; email?: string; subscriptionType?: string }
  const claudeFile = await fileOnly('claude')
  const claude: ClaudeStatus =
    claudeFile !== undefined
      ? { loggedIn: claudeFile }
      : await run('claude', ['auth', 'status', '--json'], {}).then(
          (out) => JSON.parse(out ?? '{}') as ClaudeStatus,
          () => ({ loggedIn: false }),
        )
  const codexFile = await fileOnly('codex')
  const codex =
    codexFile ??
    (await run('codex', ['login', 'status'], {}).then(
      (out) => out !== undefined && /logged in/i.test(out) && !/not logged in/i.test(out),
      () => false,
    ))
  return [
    {
      provider: 'claude_code',
      loggedIn: claude.loggedIn === true,
      ...(claude.email ? { email: claude.email } : {}),
      ...(claude.subscriptionType ? { plan: claude.subscriptionType } : {}),
    },
    { provider: 'codex', loggedIn: codex },
    // Antigravity's, only once it is there: an API from before Antigravity knows no such login.
    ...(machineAgyLogin(home) ? [{ provider: 'antigravity' as const, loggedIn: true }] : []),
  ]
}

/** A vendor CLI's output; undefined on Windows when it is not installed (vendor-cli.ts). */
async function run(
  vendor: Vendor,
  args: string[],
  env: Record<string, string>,
): Promise<string | undefined> {
  const cli = await vendorCli(vendor)
  if (!cli) return undefined
  return new Promise((resolve, reject) => {
    const child = spawn(cli[0], [...cli[1], ...args], {
      env: harnessEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', () => resolve(out))
  })
}

export class Accounts {
  private logins = new Map<string, Login>()
  /**
   * Sign-ins waiting for their CLI to install (Windows' first one): cancelled meanwhile, or given
   * way to a newer one for the same account, they never start.
   */
  private installing = new Map<string, { account: AccountRef; cancelled: boolean }>()

  constructor(
    private readonly send: {
      prompt: (loginId: string, prompt: Prompt) => void
      done: (loginId: string, done: Done) => void
    },
    /** The vendor CLI for a sign-in, installed if need be (vendor-cli.ts); tests give their own. */
    private readonly cliFor: typeof vendorCli = vendorCli,
  ) {}

  async start(loginId: string, account: AccountRef) {
    const dir = accountDir(account)
    if (!dir) throw new Error("The machine's own login is managed on the machine")
    // A sign-in the API lost (it restarted) would otherwise time out later and delete this one's login.
    const replace = () => {
      for (const login of this.logins.values())
        if (login.account.id === account.id) login.cancel('Replaced by a new sign-in', true)
      for (const waiting of this.installing.values())
        if (waiting.account.id === account.id) waiting.cancelled = true
    }
    replace()
    const waiting = { account, cancelled: false }
    this.installing.set(loginId, waiting)
    let cli: [string, string[]] | undefined
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      // On Windows, the CLI may have to be installed first: a minute or two, once. Antigravity's
      // is the runner's own pinned copy, downloaded on first use.
      cli =
        account.provider === 'antigravity'
          ? [await installAgy(), []]
          : await this.cliFor(account.provider === 'codex' ? 'codex' : 'claude', { install: true })
    } finally {
      this.installing.delete(loginId)
    }
    // Cancelled while it waited: it never starts, and leaves the account's folder to the sign-in
    // that replaced it, if any.
    if (waiting.cancelled) return this.send.done(loginId, { ok: false, error: 'Cancelled' })
    if (!cli) throw new Error('Could not install the sign-in command')
    const login = new Login(
      account,
      dir,
      (prompt) => this.send.prompt(loginId, prompt),
      (done) => {
        this.logins.delete(loginId)
        this.send.done(loginId, done)
      },
      cli,
    )
    this.logins.set(loginId, login)
  }

  /** A sign-in is in progress. */
  get busy() {
    return this.logins.size > 0 || this.installing.size > 0
  }

  submit(loginId: string, code: string) {
    const login = this.logins.get(loginId)
    if (!login) throw new Error('No sign-in is waiting for a code')
    login.submit(code)
  }

  cancel(loginId: string) {
    this.logins.get(loginId)?.cancel()
    const waiting = this.installing.get(loginId)
    if (waiting) waiting.cancelled = true
  }

  /** Sign out with the vendor's command, then delete the account's directory (and its token). */
  async remove(account: AccountRef) {
    const dir = accountDir(account)
    if (!dir) return // never sign the member's own machine login out
    // Antigravity keeps its login in the folder alone (no sign-out command to run).
    if (account.provider === 'antigravity') return rm(dir, { recursive: true, force: true })
    await run(
      account.provider === 'codex' ? 'codex' : 'claude',
      account.provider === 'codex' ? ['logout'] : ['auth', 'logout'],
      configEnv(account),
    ).catch(() => '')
    await rm(dir, { recursive: true, force: true })
  }
}
