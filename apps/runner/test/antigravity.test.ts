// Teammates on Antigravity (harness/antigravity.ts): its pinned CLI, its Google sign-in through
// Brigade, where each turn finds its login, and how its tool calls map to Brigade's tools.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { antigravityModelId, modelEffort, loginOf, runModel } from '@brigade/contracts'

// The runner's folders for this test, set before its modules read them.
const root = mkdtempSync(join(tmpdir(), 'brigade-agy-'))
process.env.BRIGADE_ANTIGRAVITY_DIR = join(root, 'cli')
process.env.BRIGADE_ACCOUNTS_DIR = join(root, 'accounts')

const agy = await import('../src/harness/antigravity.js')
const { Accounts, accountDir } = await import('../src/accounts.js')
const { EventMapper } = await import('../src/harness/events.js')

const login = (refresh: string, access = 'ya29.test') =>
  JSON.stringify({
    token: {
      access_token: access,
      token_type: 'Bearer',
      refresh_token: refresh,
      expiry: '2026-11-19T15:00:00Z',
    },
    auth_method: 'consumer',
    id_token_email: 'ada@example.com',
  })

/** A stand-in for `agy acp --login`: Google's page, then the code read from stdin, then the login. */
const FAKE_AGY = `#!/bin/sh
dir=""
while [ $# -gt 0 ]; do [ "$1" = "--gemini-dir" ] && dir="$2"; shift; done
echo "Open this link in a browser to log in with Google:"
echo ""
echo "  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=x&state=abc"
echo ""
echo "Then paste the authorization code, or the full URL of the page you land on, and press Enter:"
read code
[ "$code" = "4/good-code" ] || { echo "login failed: invalid_grant"; exit 1; }
mkdir -p "$dir/antigravity-cli"
printf '%s' '${login('refresh-1')}' > "$dir/antigravity-cli/antigravity-oauth-token"
echo "Logged in as ada@example.com."
`

function fakeCli() {
  const bin = agy.agyPath()
  mkdirSync(join(bin, '..'), { recursive: true })
  writeFileSync(bin, FAKE_AGY)
  chmodSync(bin, 0o755)
}

test('a Google account signs in with Antigravity’s own sign-in, its login kept as one private file', async () => {
  fakeCli()
  const prompts: { url: string; flow: string }[] = []
  const done = new Promise<{ ok: boolean; email?: string; error?: string }>((resolve) => {
    const accounts = new Accounts({
      prompt: (_id, prompt) => {
        prompts.push(prompt)
        accounts.submit('login-1', ' 4/good-code \n')
      },
      done: (_id, result) => resolve(result),
    })
    void accounts.start('login-1', { id: 'acct-g', provider: 'antigravity', source: 'brigade' })
  })
  const result = await done
  assert.deepEqual(result, { ok: true, email: 'ada@example.com' })
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0]!.flow, 'paste')
  assert.match(prompts[0]!.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/)
  const dir = accountDir({ id: 'acct-g', provider: 'antigravity', source: 'brigade' })!
  const file = join(dir, agy.AGY_TOKEN_FILE)
  assert.equal(agy.refreshTokenOf(readFileSync(file, 'utf8')), 'refresh-1')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  // Only the login stays: the rest of Antigravity's folder from the sign-in goes.
  assert.equal(existsSync(join(dir, '.gemini')), false)
})

test('a wrong code fails the sign-in and leaves no login', async () => {
  fakeCli()
  const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const accounts = new Accounts({
      prompt: () => accounts.submit('login-2', '4/bad'),
      done: (_id, r) => resolve(r),
    })
    void accounts.start('login-2', { id: 'acct-bad', provider: 'antigravity', source: 'brigade' })
  })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /invalid_grant/)
  // The failed sign-in's folder goes just after it says so.
  const gone = join(process.env.BRIGADE_ACCOUNTS_DIR!, 'acct-bad')
  for (let i = 0; i < 50 && existsSync(gone); i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(existsSync(gone), false)
})

test('a turn gets the account’s login where it runs, and a refreshed copy is left as it is', async () => {
  fakeCli()
  const account = { id: 'acct-t', provider: 'antigravity' as const, source: 'brigade' as const }
  const dir = accountDir(account)!
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, agy.AGY_TOKEN_FILE), login('refresh-2'), { mode: 0o600 })
  const home = mkdtempSync(join(root, 'home-'))
  const env = await agy.antigravityEnv({ account, accountDir: dir, home })
  assert.equal(env.AGY_BRIGADE_BIN, agy.agyPath())
  assert.equal(env.AGY_BRIGADE_HOME, home)
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, '1')
  assert.equal(env.AGY_BRIGADE_GEMINI_DIR, join(dir, '.gemini'))
  const copy = agy.agyTokenIn(env.AGY_BRIGADE_GEMINI_DIR!)
  assert.equal(agy.refreshTokenOf(readFileSync(copy, 'utf8')), 'refresh-2')
  // Antigravity refreshed its access token there: the same login, so kept.
  writeFileSync(copy, login('refresh-2', 'ya29.newer'))
  await agy.antigravityEnv({ account, accountDir: dir, home })
  assert.match(readFileSync(copy, 'utf8'), /ya29\.newer/)
  // Signed in again (another login): the copy follows.
  writeFileSync(join(dir, agy.AGY_TOKEN_FILE), login('refresh-3'))
  await agy.antigravityEnv({ account, accountDir: dir, home })
  assert.equal(agy.refreshTokenOf(readFileSync(copy, 'utf8')), 'refresh-3')
  // The machine's own login: used where it is, with no folder of Brigade's.
  const machine = await agy.antigravityEnv({
    account: { ...account, source: 'machine' },
    accountDir: null,
    home,
  })
  assert.equal(machine.AGY_BRIGADE_GEMINI_DIR, undefined)
})

test('an account without its login says to sign in again', async () => {
  fakeCli()
  const account = { id: 'acct-none', provider: 'antigravity' as const, source: 'brigade' as const }
  await assert.rejects(
    agy.antigravityEnv({ account, accountDir: join(root, 'nowhere'), home: root }),
    /Not logged in/,
  )
})

test('the wrapper gives Antigravity the teammate’s home and the account’s folder', () => {
  const home = mkdtempSync(join(root, 'wrapper-'))
  execFileSync('bash', ['-c', agy.WRAPPER_INSTALL], { env: { ...process.env, HOME: home } })
  const wrapper = join(home, '.local', 'bin', 'agy')
  const fake = join(home, 'fake-agy')
  writeFileSync(fake, '#!/bin/sh\necho "HOME=$HOME"\necho "ARGS=$*"\n')
  chmodSync(fake, 0o755)
  const run = (extra: Record<string, string>) =>
    execFileSync(wrapper, ['acp', '--disable-telemetry'], {
      env: { PATH: process.env.PATH!, HOME: home, AGY_BRIGADE_BIN: fake, ...extra },
    }).toString()
  assert.equal(
    run({
      AGY_BRIGADE_HOME: '/home/bt-x',
      AGY_BRIGADE_GEMINI_DIR: '/home/bt-x/.accounts/a/.gemini',
    }),
    'HOME=/home/bt-x\nARGS=acp --disable-telemetry --gemini-dir /home/bt-x/.accounts/a/.gemini\n',
  )
  assert.equal(run({}), `HOME=${home}\nARGS=acp --disable-telemetry\n`)
})

test('the pinned CLI is downloaded once, checked against its SHA-512', async () => {
  const dir = mkdtempSync(join(root, 'install-'))
  // A real archive holding `antigravity`, standing in for Google's.
  const src = mkdtempSync(join(root, 'src-'))
  writeFileSync(join(src, 'antigravity'), '#!/bin/sh\necho agy\n')
  execFileSync('tar', ['-czf', join(src, 'a.tar.gz'), '-C', src, 'antigravity'])
  const archive = readFileSync(join(src, 'a.tar.gz'))
  const build = 'linux_x64' as const
  const original = agy.AGY_RELEASE.builds[build].sha512
  let fetched = 0
  const fetchImpl = (async () => {
    fetched++
    return new Response(archive)
  }) as typeof fetch
  // Not Google's build: refused, nothing installed.
  await assert.rejects(agy.installAgy({ root: dir, fetchImpl, build }), /checksum/)
  assert.equal(existsSync(agy.agyPath(dir)), false)
  // Its checksum pinned: installed, executable, and not downloaded again.
  const sum = createHash('sha512').update(archive).digest('hex')
  ;(agy.AGY_RELEASE.builds[build] as { sha512: string }).sha512 = sum
  try {
    const bin = await agy.installAgy({ root: dir, fetchImpl, build })
    assert.equal(execFileSync(bin).toString(), 'agy\n')
    await agy.installAgy({ root: dir, fetchImpl, build })
    assert.equal(fetched, 2)
  } finally {
    ;(agy.AGY_RELEASE.builds[build] as { sha512: string }).sha512 = original
  }
})

test('Antigravity’s builds: Linux and macOS, none on Windows', () => {
  assert.equal(agy.agyBuild('linux', 'x64', false), 'linux_x64')
  assert.equal(agy.agyBuild('linux', 'arm64', true), 'linux_arm64_musl')
  assert.equal(agy.agyBuild('darwin', 'arm64', false), 'darwin_arm64')
  assert.equal(agy.agyBuild('win32', 'x64', false), undefined)
})

test('Brigade’s tools as Antigravity calls them: mcp_<server>_<tool>, without its own summary', () => {
  assert.equal(
    agy.mcpToolOf('mcp_ai-sdk-harness-tools_open_ticket', 'ai-sdk-harness-tools'),
    'open_ticket',
  )
  assert.equal(agy.mcpToolOf('run_command', 'ai-sdk-harness-tools'), undefined)
  assert.deepEqual(agy.callInput({ toolSummary: 'Echo word kiwi', word: 'kiwi' }), { word: 'kiwi' })
  assert.equal(agy.callInput(['x']), undefined)
  // The browser's MCP server, as ACP takes a stdio server: its env as pairs.
  assert.deepEqual(agy.acpMcpServer({ command: 'node', args: ['relay.js'], env: { A: '1' } }), {
    command: 'node',
    args: ['relay.js'],
    env: [{ name: 'A', value: '1' }],
  })
})

test('Antigravity’s models take the thread’s effort on their id, the nearest they have', () => {
  assert.equal(runModel('antigravity', null), 'gemini-3.8-flash')
  assert.equal(loginOf('antigravity', null), 'antigravity')
  assert.equal(antigravityModelId(null, null), 'gemini-3.8-flash-high')
  assert.equal(antigravityModelId(null, 'low'), 'gemini-3.8-flash-low')
  // Flash has no Extra high nor Max: its highest.
  assert.equal(antigravityModelId('gemini-3.8-flash', 'max'), 'gemini-3.8-flash-high')
  assert.equal(antigravityModelId('gemini-4-neon', 'max'), 'gemini-4-neon-xhigh')
  assert.equal(modelEffort('claude_code', 'claude-opus-5-5', 'max'), 'max')
})

test('Google’s quota errors are out of usage, not a failure', () => {
  assert.ok(EventMapper.exhaustedBy('RESOURCE_EXHAUSTED: You have exhausted your weekly quota'))
  assert.ok(EventMapper.exhaustedBy('Error 429: Resource exhausted'))
  assert.equal(EventMapper.exhaustedBy('Authentication required'), undefined)
})
