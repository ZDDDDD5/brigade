import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { codexLimits, readCodexLimits, refreshCodexLogin } from '../src/codex-usage.js'

// The shape of codex-cli 0.163's reply to account/rateLimits/read (GetAccountRateLimitsResponse).
const REPLY = {
  rateLimits: {
    limitId: 'codex',
    planType: 'plus',
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1792420000 },
    secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1792900000 },
  },
  rateLimitsByLimitId: null,
}

test('reads the 5-hour and weekly windows under the names Claude uses', () => {
  assert.deepEqual(codexLimits(REPLY), [
    { window: 'five_hour', utilization: 0.42, resetsAt: new Date(1792420000_000).toISOString() },
    { window: 'seven_day', utilization: 0.07, resetsAt: new Date(1792900000_000).toISOString() },
  ])
})

test('other windows by their length, and none when Codex gives none', () => {
  assert.deepEqual(
    codexLimits({ rateLimits: { primary: { usedPercent: 130, windowDurationMins: 1440 } } }),
    [{ window: '1_day', utilization: 1, resetsAt: null }],
  )
  assert.deepEqual(codexLimits({ rateLimits: { primary: null, secondary: null } }), [])
  assert.deepEqual(codexLimits(null), [])
})

/** A stand-in `codex` on PATH that answers app-server's JSON-RPC as the real one does. */
async function fakeCodex(answer: string) {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-'))
  const script = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.id === 1) console.log(JSON.stringify({ id: 1, result: { userAgent: 'fake' } }))
  if (m.id === 2) console.log(${JSON.stringify(answer)})
})
`
  await writeFile(join(dir, 'codex'), script)
  await chmod(join(dir, 'codex'), 0o755)
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`
}

test('asks codex app-server, once a minute at most per account', async () => {
  await fakeCodex(JSON.stringify({ id: 2, result: REPLY }))
  const account = { id: 'acct1', provider: 'codex', source: 'machine' } as const
  const [first, together] = await Promise.all([readCodexLimits(account), readCodexLimits(account)])
  assert.equal(first?.[0]?.utilization, 0.42)
  assert.equal(together, null)
  assert.equal(await readCodexLimits(account), null)
  // Claude accounts report their own.
  assert.equal(await readCodexLimits({ ...account, id: 'c', provider: 'claude_code' }), null)
})

test('null when Codex cannot say, such as signed out', async () => {
  await fakeCodex(
    JSON.stringify({
      id: 2,
      error: { code: -32600, message: 'codex account authentication required to read rate limits' },
    }),
  )
  assert.equal(await readCodexLimits({ id: 'acct2', provider: 'codex', source: 'machine' }), null)
})

test('a ChatGPT login is refreshed by Codex itself: account/read with refreshToken (Pi)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fake-codex-'))
  const asked = join(dir, 'asked.jsonl')
  // Keeps what it was asked, and answers as codex-cli 0.169 does (GetAccountResponse).
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  fs.appendFileSync(${JSON.stringify(asked)}, line + '\\n')
  const m = JSON.parse(line)
  if (m.id === 1) console.log(JSON.stringify({ id: 1, result: { userAgent: 'fake' } }))
  if (m.id === 2) console.log(JSON.stringify({ id: 2, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } }))
})
`
  await writeFile(join(dir, 'codex'), script)
  await chmod(join(dir, 'codex'), 0o755)
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`
  const account = { id: 'acct3', provider: 'codex', source: 'machine' } as const
  // Turns that need it together share one refresh.
  await Promise.all([refreshCodexLogin(account), refreshCodexLogin(account)])
  const lines = (await readFile(asked, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const reads = lines.filter((m) => m.method === 'account/read')
  assert.deepEqual(reads, [{ id: 2, method: 'account/read', params: { refreshToken: true } }])
})
