import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A playbook dry run's event ends with its run's turn (noteDryRunEvents, src/playbook-dry-runs.ts),
// not with a turn over while it still waits on a person's answer: a Codex teammate's ticket or
// question holds no turn (codex-asks.ts in apps/runner), and that run waits, as one whose turn is
// paused on an ask. Against the local database of apps/api/.env, in an organization of its own
// that it removes at the end. Without a database to reach, it is skipped.
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

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "dryRun" from "PlaybookRun" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma } = await import('../src/db.js')
const { noteDryRunEvents } = await import('../src/playbook-dry-runs.js')
const { inWorkspaceHub } = await import('./in-hub.js')

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-dry-asks-${id}`,
  user: `user-dry-asks-${id}`,
  member: `mem-dry-asks-${id}`,
}
let scope: { organizationId: string; workspaceId: string }
let teammateId: string
let installationId: string
let dryRunId: string
let computerId: string

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: ids.organization, name: 'Dry run asks test', slug: ids.organization },
  })
  await prisma.user.create({
    data: { id: ids.user, name: 'Ada', email: `${ids.user}@example.com` },
  })
  await prisma.member.create({
    data: { id: ids.member, organizationId: ids.organization, userId: ids.user, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Dry run asks test' },
  })
  scope = { organizationId: ids.organization, workspaceId: workspace.id }
  teammateId = (await prisma.teammate.create({ data: { ...scope, name: 'Cody' } })).id
  computerId = (
    await prisma.computer.create({
      data: { ...scope, kind: 'member_machine', memberId: ids.member, name: 'Laptop' },
    })
  ).id
  installationId = (
    await prisma.playbookInstallation.create({
      data: {
        ...scope,
        playbookKey: 'support',
        version: '1',
        manifest: {},
        teammateId,
        ownerMemberId: ids.member,
        createdByMemberId: ids.member,
      },
    })
  ).id
  // Its replay is over (done): ending a run here starts no next event.
  dryRunId = (
    await prisma.playbookDryRun.create({
      data: {
        ...scope,
        installationId,
        teammateId,
        startedByMemberId: ids.member,
        status: 'done',
      },
    })
  ).id
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: ids.organization } })
  await prisma.user.deleteMany({ where: { id: ids.user } })
  await prisma.$disconnect()
})

test('a dry run waits on a run whose turn ended with its ask still open', { skip }, async () => {
  const session = await prisma.session.create({
    data: {
      ...scope,
      teammateId,
      startedByMemberId: ids.member,
      computerId,
      title: 'Replayed event',
      status: 'idle',
    } as never,
  })
  const run = await prisma.playbookRun.create({
    data: { ...scope, installationId, dryRun: true, dryRunId, rootSessionId: session.id },
  })
  const thread = { ...session, playbookRunId: run.id }
  const status = async () =>
    (await prisma.playbookRun.findUniqueOrThrow({ where: { id: run.id } })).status

  // As the hub runs it, once a runner's events are stored (src/hub/runner-messages.ts).
  const note = (event: { type: string; waiting?: boolean }) =>
    inWorkspaceHub(scope.workspaceId, () => noteDryRunEvents(thread, [{ event }]))
  await note({ type: 'turn.completed', waiting: true })
  assert.equal(await status(), 'running')

  // The turn the answer brings ends it.
  await note({ type: 'turn.completed' })
  assert.equal(await status(), 'done')
})
