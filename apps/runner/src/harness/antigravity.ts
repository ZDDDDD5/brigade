// Teammates on Antigravity (docs/harnesses.md): Google's own CLI, `agy acp`, driven over the Agent
// Client Protocol by the AI SDK's ACP adapter (@ai-sdk/harness-acp), on a Google account with a
// Google AI plan, signed in through Brigade (accounts.ts) like a Claude or ChatGPT account.
//
// - The CLI. The runner downloads Google's build for this computer at the version pinned below,
//   checks it against the SHA-512 Google's release manifest gives, and keeps it beside the runner
//   (<install dir>/antigravity/<version>/agy), readable by every teammate. It never updates
//   itself (AGY_CLI_DISABLE_AUTO_UPDATE): a new version is a change of AGY_RELEASE here.
// - Its home. The adapter starts an installed agent with a home of its own under its bootstrap
//   folder, which Antigravity's shell commands would then run with (git's config, ssh keys and
//   the rest gone). So what it starts is a small wrapper the adapter's install writes, which gives
//   Antigravity back the teammate's home (AGY_BRIGADE_HOME) and the account's folder for its state
//   (AGY_BRIGADE_GEMINI_DIR, `--gemini-dir`), then runs the pinned CLI (AGY_BRIGADE_BIN).
// - Its login. A Brigade-signed-in account's Google login is one file, `antigravity-oauth-token`,
//   in the account's folder, readable by the runner alone (and backed up like the others:
//   account-backups.ts). Each turn copies it into the folder Antigravity runs on: the teammate's
//   own on a cloud computer (~/.accounts/<id>/.gemini), the account's on a member's machine. A
//   Google refresh token is not spent when used, so every copy stays signed in; a copy that holds
//   the same refresh token is left as it is (Antigravity may have refreshed its access token). The
//   machine's own login (a member's ~/.gemini) is used where it is, and never copied.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createACP } from '@ai-sdk/harness-acp'
import type { AccountRef } from '@brigade/contracts'

const run = promisify(execFile)

/** Google's build of the CLI, pinned: what each platform downloads, and its SHA-512. */
export const AGY_RELEASE = {
  version: '1.5.12',
  base: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.12-5281398513336320',
  builds: {
    linux_x64: {
      path: 'linux-x64/cli_linux_x64.tar.gz',
      sha512:
        '26de25fccb3fbf0b093e090ce14a14ac1df1ec3e90ef4ea6106887d3a81b0cc9edb0dadea7b9101d07f9606eba159062a6fb7b78e91b73f7520684a24db73428',
    },
    linux_arm64: {
      path: 'linux-arm/cli_linux_arm64.tar.gz',
      sha512:
        '1030d89ce9e5cb39509e272cb89b71fde0e0d5d6527b7392525d5ef2683da54fb49230449107486d91c02ded39a678faaa649b2041304a6cf82a3a332d5819d9',
    },
    linux_x64_musl: {
      path: 'linux-x64-musl/cli_linux_x64_musl.tar.gz',
      sha512:
        '4499b2a2127df1b89601ce81c9aaa1aaa7aad6d282bac8c7ed8a2b20e1f5c2bec43bd5ffcd3be7ea258d7205cf4911cd995114c311df7bf2d07fbf7d3518e4fa',
    },
    linux_arm64_musl: {
      path: 'linux-arm-musl/cli_linux_arm64_musl.tar.gz',
      sha512:
        '5379e2a0610b400e2f7152d1ba3f0500c775959ac1c52b338c6bcf15e7e6c0324bf277bbf4e4633cb1377efd42faa7689294ff08377bb61644d3ba9ecc49f9a6',
    },
    darwin_arm64: {
      path: 'darwin-arm/cli_mac_arm64.tar.gz',
      sha512:
        'f0d951b41bddb62cbee0199a60cc9a9aba16cecb95c5cf7d5c71349c745c578f2d2bbce1194b058e867e85456030ac1b1ec72772ee17b31de1d606f34cce3154',
    },
    darwin_x64: {
      path: 'darwin-x64/cli_mac_x64.tar.gz',
      sha512:
        'b392e94e593a3c93e90b14e277c80e9712c1442dba0f68a7b48918bbeb990250a544eedf791426d3afd95162128b4de320f549f2639640d20e1d25b567784c7f',
    },
  },
} as const

type Build = keyof typeof AGY_RELEASE.builds

/** This computer's build: none on Windows, where the wrapper (a shell script) cannot run. */
export function agyBuild(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isMusl(),
): Build | undefined {
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined
  if (!cpu) return undefined
  if (platform === 'darwin') return `darwin_${cpu}`
  if (platform === 'linux') return musl ? `linux_${cpu}_musl` : `linux_${cpu}`
  return undefined
}

function isMusl() {
  if (process.platform !== 'linux') return false
  // glibc's Node reports its version; a musl build has none.
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }
  return !report?.header?.glibcVersionRuntime
}

/** The runner's own folder (dist/..). Installs go beside it, where its updates leave them. */
const RUNNER_DIR = fileURLToPath(new URL('../..', import.meta.url))
export const AGY_INSTALL_ROOT =
  process.env.BRIGADE_ANTIGRAVITY_DIR ?? join(dirname(RUNNER_DIR.replace(/\/$/, '')), 'antigravity')

/** The longest a download may take: a stalled one fails, and the next turn tries again. */
const INSTALL_DEADLINE_MS = 10 * 60_000

/** Where the pinned CLI goes. */
export const agyPath = (root = AGY_INSTALL_ROOT) => join(root, AGY_RELEASE.version, 'agy')

let installing: Promise<string> | undefined

/**
 * The pinned CLI, downloaded and checked first when it is not there yet. One download at a time;
 * a failed one is tried again at the next call.
 */
export function installAgy(
  options: { root?: string; fetchImpl?: typeof fetch; build?: Build } = {},
): Promise<string> {
  const root = options.root ?? AGY_INSTALL_ROOT
  const target = agyPath(root)
  if (existsSync(target)) return Promise.resolve(target)
  const custom = options.root !== undefined
  if (installing && !custom) return installing
  const work = (async () => {
    const build = options.build ?? agyBuild()
    if (!build)
      throw new Error('Antigravity does not run on this computer yet (Linux and macOS only)')
    const { path, sha512 } = AGY_RELEASE.builds[build]
    const response = await (options.fetchImpl ?? fetch)(`${AGY_RELEASE.base}/${path}`, {
      signal: AbortSignal.timeout(INSTALL_DEADLINE_MS),
    })
    if (!response.ok)
      throw new Error(`Antigravity could not be downloaded: HTTP ${response.status}`)
    const archive = Buffer.from(await response.arrayBuffer())
    const sum = createHash('sha512').update(archive).digest('hex')
    if (sum !== sha512) throw new Error('Antigravity download does not match its checksum')
    await mkdir(dirname(target), { recursive: true, mode: 0o755 })
    // Unpacked next to where it goes, then renamed there: a runner stopped halfway leaves no
    // half-written binary where the next look would find it.
    const staging = await mkdtemp(`${target}.`)
    try {
      await writeFile(join(staging, 'agy.tar.gz'), archive)
      await run('tar', ['-xzf', 'agy.tar.gz', 'antigravity'], { cwd: staging })
      await chmod(join(staging, 'antigravity'), 0o755)
      await rename(join(staging, 'antigravity'), target)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    await chmod(dirname(target), 0o755)
    return target
  })()
  if (custom) return work
  installing = work
  work.catch(() => {
    if (installing === work) installing = undefined
  })
  return work
}

/** The account's Google login, in its folder: written by the sign-in, read by the runner alone. */
export const AGY_TOKEN_FILE = 'antigravity-oauth-token'
/** Where Antigravity keeps its login under its folder (--gemini-dir). */
export const agyTokenIn = (geminiDir: string) => join(geminiDir, 'antigravity-cli', AGY_TOKEN_FILE)

/** A login's refresh token, to tell whether two copies are the same login. Never logged. */
export function refreshTokenOf(login: string | undefined): string | undefined {
  if (!login) return undefined
  try {
    const parsed = JSON.parse(login) as { token?: { refresh_token?: unknown } }
    const token = parsed.token?.refresh_token
    return typeof token === 'string' && token ? token : undefined
  } catch {
    return undefined
  }
}

/** Who a login is, as Antigravity's sign-in saved it. Never the credential. */
export function loginEmail(login: string | undefined): string | undefined {
  if (!login) return undefined
  try {
    const email = (JSON.parse(login) as { id_token_email?: unknown }).id_token_email
    return typeof email === 'string' && email.includes('@') ? email : undefined
  } catch {
    return undefined
  }
}

/**
 * After Antigravity's sign-in into `<dir>/.gemini`: its login kept as the account's one file, the
 * rest of that folder (its logs, an empty conversation store) dropped. Says who signed in.
 */
export async function keepLogin(dir: string): Promise<{ email?: string }> {
  const signedIn = join(dir, '.gemini')
  const login = await readFile(agyTokenIn(signedIn), 'utf8')
  if (!refreshTokenOf(login)) throw new Error('Antigravity saved no Google login')
  const temp = join(dir, `.${AGY_TOKEN_FILE}.new`)
  await writeFile(temp, login, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, join(dir, AGY_TOKEN_FILE))
  await rm(signedIn, { recursive: true, force: true })
  const email = loginEmail(login)
  return email ? { email } : {}
}

/** A file's content as `user` reads it (a teammate's, on a cloud computer); undefined when none. */
function readAs(user: string, file: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-n', '-u', user, 'cat', '--', file], {
      cwd: '/',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => resolve(code === 0 ? out : undefined))
  })
}

/** Write a private file as `user`, made anew and renamed over the old one. */
function writeAs(user: string, file: string, content: string): Promise<void> {
  const script =
    'set -e; umask 077; mkdir -p "$(dirname "$1")"; t="$1.brigade-$$"; cat >"$t"; mv -f "$t" "$1"'
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', '-u', user, 'sh', '-c', script, 'sh', file], {
      cwd: '/',
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`)),
    )
    child.stdin.on('error', () => undefined)
    child.stdin.end(content)
  })
}

/**
 * The environment a turn on Antigravity runs with (beside the account's), its login copied to
 * where it runs. `accountDir` is the account's folder (accountDir in accounts.ts), null for the
 * machine's own login; `home`, the home its commands run in (the teammate's, on a cloud computer).
 */
export async function antigravityEnv(options: {
  account: AccountRef
  accountDir: string | null
  home: string
  runAs?: string
  root?: string
}): Promise<Record<string, string>> {
  const bin = await installAgy(options.root ? { root: options.root } : {})
  const env: Record<string, string> = {
    AGY_BRIGADE_BIN: bin,
    AGY_BRIGADE_HOME: options.home,
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
  }
  if (!options.accountDir) return env
  const login = await readFile(join(options.accountDir, AGY_TOKEN_FILE), 'utf8').catch(() => {
    throw new Error('Not logged in: this Google account has no Antigravity login. Sign in again.')
  })
  const geminiDir = options.runAs
    ? join(options.home, '.accounts', options.account.id, '.gemini')
    : join(options.accountDir, '.gemini')
  const file = agyTokenIn(geminiDir)
  const current = options.runAs
    ? await readAs(options.runAs, file)
    : await readFile(file, 'utf8').catch(() => undefined)
  if (refreshTokenOf(current) !== refreshTokenOf(login)) {
    if (options.runAs) await writeAs(options.runAs, file, login)
    else {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(`${file}.brigade`, login, { mode: 0o600 })
      await rename(`${file}.brigade`, file)
    }
  }
  return { ...env, AGY_BRIGADE_GEMINI_DIR: geminiDir }
}

/** Whether the machine's own Antigravity is signed in (a member's ~/.gemini), never read. */
export const machineAgyLogin = (home = homedir()) => existsSync(agyTokenIn(join(home, '.gemini')))

/**
 * What the adapter's install writes as the agent it starts: the wrapper that gives Antigravity
 * back the teammate's home and the account's folder (see the top of this file). Run by the
 * adapter's install script, in its own home (`$HOME/.local/bin` is where it looks).
 */
export const WRAPPER_INSTALL = `mkdir -p "$HOME/.local/bin"
cat >"$HOME/.local/bin/agy" <<'AGY'
#!/bin/sh
# Brigade: Antigravity in the teammate's own home, on the account's folder (harness/antigravity.ts).
[ -n "\${AGY_BRIGADE_HOME:-}" ] && export HOME="$AGY_BRIGADE_HOME"
[ -n "\${AGY_BRIGADE_BIN:-}" ] || { echo "Antigravity is not installed" >&2; exit 127; }
if [ -n "\${AGY_BRIGADE_GEMINI_DIR:-}" ]; then
  exec "$AGY_BRIGADE_BIN" "$@" --gemini-dir "$AGY_BRIGADE_GEMINI_DIR"
fi
exec "$AGY_BRIGADE_BIN" "$@"
AGY
chmod 755 "$HOME/.local/bin/agy"`

/** The MCP server the ACP adapter serves Brigade's tools through, as Antigravity names its tools. */
const HOST_SERVER = 'ai-sdk-harness-tools'
/** What Antigravity adds to every tool call's input: its one-line summary for its own UI. */
const ADDED_INPUT = ['toolSummary']

/** An MCP tool's call, as Antigravity names it: `mcp_<server>_<tool>`. */
export function mcpToolOf(name: string | null | undefined, server: string): string | undefined {
  const prefix = `mcp_${server}_`
  return name?.startsWith(prefix) ? name.slice(prefix.length) : undefined
}

/** A tool call's input, without what Antigravity adds to it. */
export function callInput(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const input = { ...(raw as Record<string, unknown>) }
  for (const key of ADDED_INPUT) delete input[key]
  return input
}

/** An MCP server of Brigade's (the browser), as ACP takes it: its env a list of pairs. */
export function acpMcpServer(server: unknown): Record<string, unknown> {
  const s = server as { type?: string; command?: string; args?: string[]; env?: unknown }
  if (s.type !== undefined && s.type !== 'stdio') return s as Record<string, unknown>
  const env = Array.isArray(s.env)
    ? s.env
    : Object.entries((s.env ?? {}) as Record<string, string>).map(([name, value]) => ({
        name,
        value,
      }))
  return { command: s.command, args: s.args ?? [], env }
}

/** The harness: Antigravity's ACP server, with Brigade's tools and the browser as MCP servers. */
export function createAntigravityHarness(options: { mcpServers: Record<string, unknown> }) {
  return createACP({
    harnessId: 'antigravity',
    source: { type: 'install-command', command: WRAPPER_INSTALL },
    executable: 'agy',
    args: ['acp', '--disable-telemetry'],
    mcpServers: Object.fromEntries(
      Object.entries(options.mcpServers).map(([name, server]) => [name, acpMcpServer(server)]),
    ),
    // The thinking level is part of the model's id (antigravityModelId): session/set_model.
    modelMapping: { type: 'session-model', path: 'modelId' },
    // The teammate's own instructions, after Brigade's (AGENTS.md, which Antigravity reads), in
    // its system prompt.
    instructionMapping: { type: 'session-meta', path: ['antigravity', 'systemPrompt', 'append'] },
    isMcpToolCall: (toolCall) => /^mcp_/.test(toolCall.name ?? ''),
    resolveHostToolCall: ({ toolCall, serverName, toolNames }) => {
      const toolName = mcpToolOf(toolCall.name, serverName || HOST_SERVER)
      if (!toolName || !toolNames.includes(toolName)) return undefined
      const input = callInput(toolCall.rawInput)
      return input ? { toolName, input } : undefined
    },
    // Screenshots from the browser and image results reach the model.
    nonTextContentTypes: ['image'],
  })
}
