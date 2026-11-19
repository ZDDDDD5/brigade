// Teammates on Antigravity (harness/antigravity.ts): its pinned CLI, its Google sign-in through
// Brigade, where each turn finds its login, and how its tool calls map to Brigade's tools.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  readdirSync,
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
process.env.BRIGADE_HOME = join(root, 'brigade-home')

const agy = await import('../src/harness/antigravity.js')
const { Accounts, accountDir, machineAntigravityLogin } = await import('../src/accounts.js')
const { writeLogin } = await import('../src/account-backups.js')
const { EventMapper } = await import('../src/harness/events.js')

/** A sign-in attempt's folders still in an account's folder. */
const attempts = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('.signing-in')) : []
/** Wait for a failed sign-in's folder to go (just after it says so). */
const settled = async (dir: string) => {
  for (let i = 0; i < 50 && attempts(dir).length; i++) await new Promise((r) => setTimeout(r, 20))
}

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
  assert.deepEqual(attempts(dir), [])
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
  // The failed sign-in's folder goes just after it says so, and no login is left.
  const dir = join(process.env.BRIGADE_ACCOUNTS_DIR!, 'acct-bad')
  await settled(dir)
  assert.deepEqual(attempts(dir), [])
  assert.equal(existsSync(join(dir, agy.AGY_TOKEN_FILE)), false)
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

/** Sign the account in again through Accounts, with the stand-in CLI and this code. */
const signIn = (id: string, loginId: string, code: string) =>
  new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const accounts = new Accounts({
      prompt: () => accounts.submit(loginId, code),
      done: (_id, r) => resolve(r),
    })
    void accounts.start(loginId, { id, provider: 'antigravity', source: 'brigade' })
  })

test('signing in again, or failing to, keeps the conversations a member’s machine ran there', async () => {
  fakeCli()
  const account = { id: 'acct-again', provider: 'antigravity' as const, source: 'brigade' as const }
  const dir = accountDir(account)!
  mkdirSync(join(dir, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true })
  const conversation = join(dir, '.gemini', 'antigravity-cli', 'conversations', 'c1.pb')
  writeFileSync(conversation, 'a conversation')
  writeFileSync(join(dir, agy.AGY_TOKEN_FILE), login('refresh-old'), { mode: 0o600 })
  assert.equal((await signIn(account.id, 'again-1', '4/bad')).ok, false)
  await settled(dir)
  // Failed: the account's login and its conversations are as they were.
  assert.equal(
    agy.refreshTokenOf(readFileSync(join(dir, agy.AGY_TOKEN_FILE), 'utf8')),
    'refresh-old',
  )
  assert.equal(readFileSync(conversation, 'utf8'), 'a conversation')
  assert.deepEqual(attempts(dir), [])
  assert.deepEqual(await signIn(account.id, 'again-2', '4/good-code'), {
    ok: true,
    email: 'ada@example.com',
  })
  assert.equal(agy.refreshTokenOf(readFileSync(join(dir, agy.AGY_TOKEN_FILE), 'utf8')), 'refresh-1')
  assert.equal(readFileSync(conversation, 'utf8'), 'a conversation')
})

test('a turn and a title run starting together on a new account both get its login', async () => {
  fakeCli()
  for (let i = 0; i < 20; i++) {
    const account = {
      id: `acct-race-${i}`,
      provider: 'antigravity' as const,
      source: 'brigade' as const,
    }
    const dir = accountDir(account)!
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, agy.AGY_TOKEN_FILE), login(`refresh-race-${i}`), { mode: 0o600 })
    const home = mkdtempSync(join(root, 'race-'))
    const both = await Promise.all([
      agy.antigravityEnv({ account, accountDir: dir, home }),
      agy.antigravityEnv({ account, accountDir: dir, home }),
    ])
    const copy = agy.agyTokenIn(both[0].AGY_BRIGADE_GEMINI_DIR!)
    assert.equal(agy.refreshTokenOf(readFileSync(copy, 'utf8')), `refresh-race-${i}`)
  }
})

test('a Google login put back from its backup keeps its folder the runner’s alone', async () => {
  const dir = join(process.env.BRIGADE_ACCOUNTS_DIR!, 'acct-restored')
  mkdirSync(dir, { recursive: true, mode: 0o770 })
  chmodSync(dir, 0o770)
  // Put back over a copy already there, readable by the folder's group.
  writeFileSync(join(dir, agy.AGY_TOKEN_FILE), login('refresh-before'), { mode: 0o660 })
  const content = Buffer.from(login('refresh-backup')).toString('base64')
  await writeLogin(dir, 'acct-restored', {
    files: [{ name: agy.AGY_TOKEN_FILE, content }],
    sha256: 'x',
  })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, agy.AGY_TOKEN_FILE)).mode & 0o777, 0o600)
  assert.equal(
    agy.refreshTokenOf(readFileSync(join(dir, agy.AGY_TOKEN_FILE), 'utf8')),
    'refresh-backup',
  )
})

test('a machine signed out of Antigravity says so, once it had a login', () => {
  const home = mkdtempSync(join(root, 'machine-'))
  // Never had one: nothing said, for an API from before Antigravity.
  assert.deepEqual(machineAntigravityLogin(home), [])
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  writeFileSync(agy.agyTokenIn(join(home, '.gemini')), login('refresh-m'))
  assert.deepEqual(machineAntigravityLogin(home), [{ provider: 'antigravity', loggedIn: true }])
  // Signed out since: said, so its account is no longer used.
  execFileSync('rm', ['-f', agy.agyTokenIn(join(home, '.gemini'))])
  assert.deepEqual(machineAntigravityLogin(home), [{ provider: 'antigravity', loggedIn: false }])
})

test('a sign-in a newer one replaced saves nothing over the newer one’s login', async () => {
  const dir = join(process.env.BRIGADE_ACCOUNTS_DIR!, 'acct-two-sign-ins')
  const attempt = (name: string, refresh: string) => {
    const folder = join(dir, agy.signInDir(name), 'antigravity-cli')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, agy.AGY_TOKEN_FILE), login(refresh))
  }
  attempt('old', 'refresh-old-attempt')
  attempt('new', 'refresh-new-attempt')
  // The old one's save starts first; a newer sign-in replaces it before it lands.
  let replaced = false
  const old = agy.keepLogin(dir, 'old', () => !replaced)
  replaced = true
  const newer = agy.keepLogin(dir, 'new', () => true)
  await assert.rejects(old, /Replaced by a new sign-in/)
  await newer
  assert.equal(
    agy.refreshTokenOf(readFileSync(join(dir, agy.AGY_TOKEN_FILE), 'utf8')),
    'refresh-new-attempt',
  )
  // Each took only its own folder away.
  assert.deepEqual(attempts(dir), [])
  // The old one's CLI ending only after the newer one saved: it lands nothing over it either.
  attempt('old', 'refresh-old-attempt')
  attempt('new', 'refresh-newest-attempt')
  const newest = agy.keepLogin(dir, 'new', () => true)
  const late = agy.keepLogin(dir, 'old', () => false)
  await newest
  await assert.rejects(late, /Replaced by a new sign-in/)
  assert.equal(
    agy.refreshTokenOf(readFileSync(join(dir, agy.AGY_TOKEN_FILE), 'utf8')),
    'refresh-newest-attempt',
  )
  assert.deepEqual(attempts(dir), [])
})

/** `sudo` for these tests: fails, or runs the command as this user (its -n -u <user> left out). */
function fakeSudo(works: boolean) {
  const bin = mkdtempSync(join(root, 'sudo-'))
  writeFileSync(
    join(bin, 'sudo'),
    works
      ? '#!/bin/sh\nshift 3\n[ "$1" = "--" ] && shift\nexec "$@"\n'
      : '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n',
  )
  chmodSync(join(bin, 'sudo'), 0o755)
  return bin
}

test('a removed account’s copies in teammates’ homes are tried again until they are gone', async () => {
  const homes = mkdtempSync(join(root, 'homes-'))
  const copy = join(homes, 'bt-gemma', '.accounts', 'acct-removed', '.gemini')
  mkdirSync(copy, { recursive: true })
  writeFileSync(join(copy, 'antigravity-oauth-token'), login('refresh-removed'))
  process.env.BRIGADE_ANTIGRAVITY_REMOVED = join(root, 'removed.json')
  const path = process.env.PATH
  try {
    await agy.fenceRemoved('acct-removed', true)
    // The teammate's copy cannot be removed: said, and kept for the next try.
    process.env.PATH = `${fakeSudo(false)}:${path}`
    await assert.rejects(agy.cleanRemoved(homes), /acct-removed: bt-gemma: sudo: a password/)
    assert.ok(existsSync(copy))
    assert.deepEqual(JSON.parse(readFileSync(process.env.BRIGADE_ANTIGRAVITY_REMOVED, 'utf8')), [
      'acct-removed',
    ])
    // The next try removes it, and the account leaves the list.
    process.env.PATH = `${fakeSudo(true)}:${path}`
    await agy.cleanRemoved(homes)
    assert.equal(existsSync(join(homes, 'bt-gemma', '.accounts', 'acct-removed')), false)
    assert.deepEqual(JSON.parse(readFileSync(process.env.BRIGADE_ANTIGRAVITY_REMOVED, 'utf8')), [])
  } finally {
    process.env.PATH = path
  }
})

test('a turn that read the login just before its account was removed starts nothing', async () => {
  fakeCli()
  const account = {
    id: 'acct-fenced',
    provider: 'antigravity' as const,
    source: 'brigade' as const,
  }
  const dir = accountDir(account)!
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, agy.AGY_TOKEN_FILE), login('refresh-fenced'), { mode: 0o600 })
  const home = mkdtempSync(join(root, 'fenced-'))
  // The account is removed after the turn read its login, before it wrote its copy.
  await assert.rejects(
    agy.antigravityEnv({
      account,
      accountDir: dir,
      home,
      afterRead: () => agy.fenceRemoved(account.id, false),
    }),
    /was removed/,
  )
  assert.equal(existsSync(join(dir, '.gemini')), false)
  // And nothing later starts on it.
  assert.equal(agy.isRemoved(account.id), true)
  await assert.rejects(agy.antigravityEnv({ account, accountDir: dir, home }), /was removed/)
})
