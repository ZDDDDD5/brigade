import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { after, before, beforeEach, test } from 'node:test'
import pg from 'pg'

// A cloud computer marked running whose runner stays away, on a machine boat no longer saves, is
// recovered (src/cloud.ts's recoverAway, src/runner-away.ts's recoveryStep). On Nov 6–7, the
// workspace computer's disk restore failed two minutes after a resume: boat saved nothing more,
// refused every stop without force, and kept it running, unreachable, for six hours. boat's API is
// faked, answering as a throwaway sandbox did on Nov 7; the database is the local one of
// apps/api/.env, in an organization of its own removed at the end. Without a database to reach,
// the tests that need one are skipped.
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
process.env.BOAT_API_KEY = 'test'

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "id" from "Computer" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

// boat, faked: a machine whose agent refuses every command, as on Nov 7, and that boat saved last
// at `saved` (by sandbox; long ago unless said).
const { BoatApi } = createRequire(
  new URL('../../../packages/providers/package.json', import.meta.url),
)('@boatdev/sdk') as typeof import('@boatdev/sdk')
const MIN = 60_000
const boat = {
  stops: [] as { sandbox: string; force: boolean }[],
  resumes: [] as string[],
  commands: [] as string[],
  recovers: [] as string[],
  /** New sandboxes made (a replacement's new VM). */
  creates: [] as string[],
  /** By sandbox: its state; ready unless said. */
  states: new Map<string, string>(),
  /** By sandbox: its last check (verified) and its last completed snapshot. */
  saved: new Map<string, { verified: Date | null; snapshot: Date | null }>(),
  /** What a recover answers: accepted, or a 409's code (as boat's baremetal machines do). */
  recoverAnswer: 'recover_unsupported' as string,
  /** Holds each recover's answer until it resolves. */
  answering: null as Promise<void> | null,
}
const longAgo = () => new Date(Date.now() - 2 * 60 * MIN)
const conflict = (code: string) =>
  Object.assign(new Error('Response returned an error code'), {
    response: new Response(JSON.stringify({ ok: false, status: 409, code, error: { code } }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }),
  })
Object.assign(BoatApi.prototype, {
  get: async ({ sandboxId }: { sandboxId: string }) => {
    const saved = boat.saved.get(sandboxId) ?? { verified: longAgo(), snapshot: longAgo() }
    return {
      sandbox: {
        id: sandboxId,
        state: boat.states.get(sandboxId) ?? 'ready',
        health: 'ok',
        snapshotCompletedAt: saved.snapshot,
        snapshotVerifiedAt: saved.verified,
      },
    }
  },
  update: async () => ({}),
  stop: async ({
    sandboxId,
    stopRequest,
  }: {
    sandboxId: string
    stopRequest?: { force?: boolean }
  }) => {
    boat.stops.push({ sandbox: sandboxId, force: stopRequest?.force === true })
    boat.states.set(sandboxId, 'archived')
    return {}
  },
  resume: async ({ sandboxId }: { sandboxId: string }) => {
    boat.resumes.push(sandboxId)
    boat.states.delete(sandboxId)
    return {}
  },
  recover: async ({ sandboxId }: { sandboxId: string }) => {
    boat.recovers.push(sandboxId)
    await boat.answering
    if (boat.recoverAnswer !== 'accept') throw conflict(boat.recoverAnswer)
    return { ok: true, status: 'recovering' }
  },
  create: async () => {
    const sandboxId = `sb-new-${randomUUID().slice(0, 8)}`
    boat.creates.push(sandboxId)
    return { sandbox: { id: sandboxId, state: 'ready' } }
  },
  command: async ({ sandboxId }: { sandboxId: string }) => {
    boat.commands.push(sandboxId)
    throw new Error('the sandbox agent is not reachable')
  },
})

const { prisma } = await import('../src/db.js')
const cloud = await import('../src/cloud.js')
const {
  AUTO_REPLACE_LIMIT,
  REACHABLE_REPLACE_MS,
  RECOVER_AFTER_MS,
  RECOVER_AGAIN_MS,
  RECOVER_LIMIT,
  RECOVER_WAIT_MS,
  UNSAVED_MS,
  awayFor,
  recoveryStep,
} = await import('../src/runner-away.js')
const { computerProblem } = await import('../src/ops/checks.js')
const { AUTOMATIC_REPLACEMENT, replaceAutomatically } = await import('../src/cloud-replace.js')
const { localHub } = await import('../src/hub/memory-host.js')
const { inWorkspaceHub, fakeRunner } = await import('./in-hub.js')

const id = randomUUID().slice(0, 8)
const organizationId = `org-cloud-recover-${id}`
let workspaceId = ''

before(async () => {
  if (skip) return
  await prisma.organization.create({
    data: { id: organizationId, name: organizationId, slug: organizationId },
  })
  workspaceId = (await prisma.workspace.create({ data: { organizationId, name: 'recover' } })).id
})

// What boat answers is set by each test that needs another: never carried from one to the next.
beforeEach(() => {
  boat.recoverAnswer = 'recover_unsupported'
  boat.answering = null
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.$disconnect()
})

/** The workspace's cloud computer, marked running `minutesAgo`, with no runner connected. */
async function runningComputer(minutesAgo: number) {
  const computer = await prisma.computer.create({
    data: {
      organizationId,
      workspaceId,
      kind: 'cloud',
      name: 'Cloud computer',
      status: 'running',
      providerRef: { provider: 'boat', id: `sb-${randomUUID().slice(0, 8)}` },
    },
  })
  await prisma.runner.create({
    data: { organizationId, workspaceId, computerId: computer.id, tokenHash: randomUUID() },
  })
  return marked(computer.id, minutesAgo)
}

/** Its row as it is, its status last changed `minutesAgo`. */
async function marked(computerId: string, minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * MIN)
  await prisma.$executeRaw`UPDATE "Computer" SET "updatedAt" = ${at} WHERE "id" = ${computerId}`
  return prisma.computer.findUniqueOrThrow({ where: { id: computerId } })
}

const sandboxOf = (computer: { providerRef: unknown }) =>
  (computer.providerRef as { id: string }).id

const statusOf = async (computerId: string) =>
  (await prisma.computer.findUniqueOrThrow({ where: { id: computerId } })).status

/** Wait for a computer to reach a status: its start runs in the background. */
async function until(computerId: string, status: string) {
  const statusOf = async () =>
    (await prisma.computer.findUniqueOrThrow({ where: { id: computerId } })).status
  for (let i = 0; i < 200 && (await statusOf()) !== status; i++)
    await new Promise((resolve) => setTimeout(resolve, 20))
  return statusOf()
}

const inHub = <T>(fn: () => T) => inWorkspaceHub(workspaceId, fn)

/** boat saved the computer's disk last `minutesAgo` (a check and a snapshot then), or never. */
function savedAgo(computer: { providerRef: unknown }, minutesAgo: number | null) {
  const at = minutesAgo === null ? null : new Date(Date.now() - minutesAgo * MIN)
  boat.saved.set(sandboxOf(computer), { verified: at, snapshot: at })
}

const stopsOf = (computer: { providerRef: unknown }) =>
  boat.stops.filter((s) => s.sandbox === sandboxOf(computer))

test('how long a runner is away counts from its status change too', () => {
  const now = Date.now()
  assert.equal(awayFor(null, { updatedAt: new Date(now - 60 * MIN) }, now), 0)
  // Away for an hour, but its computer was restarted 5 minutes ago: 5 minutes.
  assert.equal(
    awayFor({ since: now - 60 * MIN }, { updatedAt: new Date(now - 5 * MIN) }, now),
    5 * MIN,
  )
  assert.equal(
    awayFor({ since: now - 20 * MIN }, { updatedAt: new Date(now - 60 * MIN) }, now),
    20 * MIN,
  )
})

test('what Brigade does for a runner away, from what boat last saved', () => {
  const now = Date.now()
  const away = { since: now - 60 * MIN, restarts: 0 }
  const lost = {
    awayMs: RECOVER_AFTER_MS,
    savedAt: now - UNSAVED_MS,
    snapshotAt: now - UNSAVED_MS,
    diskFull: false,
    replaced: 0,
    now,
  }
  // Nov 6, 23:23: its runner away 20 minutes, nothing saved since 23:01: boat is asked first.
  assert.equal(recoveryStep(away, lost), 'recover')
  // Away for less, or boat still saving it (its machine answers: its runner is the trouble, and a
  // new VM would not help): nothing.
  assert.equal(recoveryStep(away, { ...lost, awayMs: RECOVER_AFTER_MS - 1 }), 'none')
  assert.equal(recoveryStep(away, { ...lost, savedAt: now - UNSAVED_MS + MIN }), 'none')
  // Saved lately, but none of its commands reached it for UNSAVED_MS (Nov 18: boat's snapshots
  // went on for 34 minutes after a resume whose machine never ran a command): as unsaved.
  const saving = { ...lost, savedAt: now - MIN }
  assert.equal(recoveryStep({ ...away, unreachedSince: now - UNSAVED_MS }, saving), 'recover')
  assert.equal(recoveryStep({ ...away, unreachedSince: now - UNSAVED_MS + MIN }, saving), 'none')
  // boat cannot power-cycle it (its baremetal machines), or could not: stopped with its last
  // snapshot and started again, which keeps its whole disk.
  const impossible = { ...away, recover: 'impossible' as const, recoverAskedAt: now }
  assert.equal(recoveryStep(impossible, lost), 'restart')
  // boat power-cycles it: its runner is waited for, then the same.
  const recovering = { ...away, recover: 'recovering' as const, recoverAskedAt: now }
  assert.equal(recoveryStep(recovering, lost), 'none')
  assert.equal(recoveryStep(recovering, { ...lost, now: now + RECOVER_WAIT_MS }), 'restart')
  // Still away after RECOVER_LIMIT restarts (Nov 18: three on the same host, its restore stuck at
  // 15%): moved to a new VM.
  assert.equal(recoveryStep({ ...impossible, restarts: RECOVER_LIMIT }, lost), 'replace')
  // Nothing to restart from, or a full disk boat would not start again: moved at once.
  assert.equal(recoveryStep(impossible, { ...lost, snapshotAt: null }), 'replace')
  assert.equal(recoveryStep(impossible, { ...lost, savedAt: null, snapshotAt: null }), 'replace')
  assert.equal(recoveryStep(impossible, { ...lost, diskFull: true }), 'replace')
  // boat reaches it though it does not save it (a full disk?): asked again later, and moved once
  // it has stayed so for REACHABLE_REPLACE_MS.
  const reachable = { ...away, recover: 'reachable' as const, recoverAskedAt: now }
  assert.equal(recoveryStep(reachable, lost), 'none')
  assert.equal(recoveryStep(reachable, { ...lost, now: now + RECOVER_AGAIN_MS }), 'recover')
  assert.equal(
    recoveryStep(reachable, { ...lost, awayMs: RECOVER_AFTER_MS + REACHABLE_REPLACE_MS }),
    'replace',
  )
  // Moved AUTO_REPLACE_LIMIT times lately: its new VMs do not stay up either, left to operators.
  const many = { ...lost, replaced: AUTO_REPLACE_LIMIT }
  assert.equal(recoveryStep({ ...impossible, restarts: RECOVER_LIMIT }, many), 'give-up')
  assert.equal(recoveryStep(impossible, { ...many, snapshotAt: null }), 'give-up')
  assert.equal(recoveryStep({ ...impossible, restarts: 1, gaveUp: true }, lost), 'none')
})

test(
  'a machine boat no longer saves is stopped with its last snapshot and started again',
  { skip },
  async () => {
    const computer = await runningComputer(30)
    const sandbox = sandboxOf(computer)
    const hub = localHub(workspaceId)
    // Nov 6 at 23:24: its runner away for 21 minutes, boat's last save 23 minutes ago.
    hub.runnerAway(computer.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(computer, 23)

    await inHub(() => cloud.checkIdle(computer))
    // Its service was started for it, not waited for (boat held such commands 10 minutes on Nov
    // 18): boat refused, as on Nov 7. Its disk was not asked about before the stop: nothing
    // reaches it.
    for (let i = 0; i < 100 && !boat.commands.includes(sandbox); i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(
      boat.commands.filter((c) => c === sandbox),
      [sandbox],
    )
    // boat was asked to recover it, could not, and it was stopped with its last snapshot.
    assert.deepEqual(
      boat.recovers.filter((r) => r === sandbox),
      [sandbox],
    )
    assert.deepEqual(stopsOf(computer), [{ sandbox, force: true }])
    // Then started again, and marked running once boat has it up.
    assert.equal(await until(computer.id, 'running'), 'running')
    assert.deepEqual(boat.resumes, [sandbox])
    assert.equal(hub.runnerAway(computer.id)?.restarts, 1)
    assert.equal(hub.runnerAway(computer.id)?.recover, undefined)
    // Its start's audit is written once it is marked running.
    const actions = async () =>
      (
        await prisma.auditEntry.findMany({
          where: { targetId: computer.id },
          orderBy: { at: 'asc' },
          select: { action: true },
        })
      ).map((a) => a.action)
    for (let i = 0; i < 100 && (await actions()).length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(await actions(), ['computer.stopped', 'computer.started'])

    // Just started again: nothing before RECOVER_AFTER_MS from then, though away for longer.
    let row = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })
    assert.equal(
      await inHub(() => cloud.recoverAway(row, Date.now() + RECOVER_AFTER_MS - MIN)),
      false,
    )
    assert.equal(stopsOf(computer).length, 1)

    // Still away and unsaved after it (Nov 18: three restarts on the same host, its restore stuck
    // at 15%): moved to a new VM by itself, as a member's Replace cloud computer does. Its old VM
    // is stopped with force (boat refuses a plain stop to a machine it has not saved for 30
    // minutes), kept on the replacement, never destroyed.
    row = await marked(computer.id, 21)
    assert.equal(await inHub(() => cloud.recoverAway(row)), true)
    const replacement = async () =>
      prisma.computerReplacement.findFirst({ where: { computerId: computer.id } })
    for (let i = 0; i < 200 && (await replacement())?.phase !== 'creating'; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    const made = await replacement()
    assert.equal(made?.phase, 'creating')
    assert.equal(made?.memberId, AUTOMATIC_REPLACEMENT)
    assert.equal(made?.backup, 'not backed up: it was offline, its latest backups are used')
    assert.deepEqual(made?.oldProviderRef, { provider: 'boat', id: sandbox })
    assert.equal(stopsOf(computer).length, 2)
    assert.deepEqual(stopsOf(computer).at(-1), { sandbox, force: true })
    // Never started again meanwhile: only the restart resumed it.
    assert.deepEqual(boat.resumes, [sandbox])
    const after = await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })
    assert.notDeepEqual(after.providerRef, computer.providerRef)
    // Asked for by Brigade, said so in its audit.
    const asked = await prisma.auditEntry.findFirst({
      where: { targetId: computer.id, action: 'computer.replace_requested' },
    })
    assert.equal(asked?.actorType, 'system')
    // Being replaced: not replaced again.
    assert.equal(await inHub(() => replaceAutomatically(after)), false)
    assert.equal(await prisma.computerReplacement.count({ where: { computerId: computer.id } }), 1)
    // Its new VM's making ends (it fails here: this boat runs no command), then the replacement.
    for (let i = 0; i < 200 && (await statusOf(computer.id)) === 'creating'; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    await prisma.computerReplacement.updateMany({
      where: { computerId: computer.id },
      data: { phase: 'done' },
    })
    await prisma.computer.update({
      where: { id: computer.id },
      data: { status: 'running', providerRef: computer.providerRef as never },
    })

    // Moved AUTO_REPLACE_LIMIT times lately and still away: left to operators, and its alert says
    // so.
    await prisma.computerReplacement.create({
      data: {
        organizationId,
        workspaceId,
        computerId: computer.id,
        memberId: AUTOMATIC_REPLACEMENT,
        phase: 'done',
      },
    })
    localHub(workspaceId).noteAwayRestart(computer.id)
    row = await marked(computer.id, 60)
    assert.equal(await inHub(() => cloud.recoverAway(row)), false)
    assert.equal(await prisma.computerReplacement.count({ where: { computerId: computer.id } }), 2)
    assert.equal(hub.runnerAway(computer.id)?.gaveUp, true)
    const alert = computerProblem(
      { ...row, workspace: { name: 'recover' } },
      false,
      awayFor(hub.runnerAway(computer.id), row),
      Date.now(),
      hub.runnerAway(computer.id),
    )
    assert.equal(alert?.severity, 'warning')
    assert.match(alert?.detail ?? '', /moved it to a new VM 2 times within 6 h, and no longer does/)

    // Its runner connects: nothing is away any more, and nothing is done.
    const runner = await fakeRunner({ organizationId, workspaceId }, computer.id)
    assert.equal(hub.runnerAway(computer.id), null)
    assert.equal(await inHub(() => cloud.recoverAway(row)), false)
    runner.close()
  },
)

test(
  'a machine boat still saves but gets no command to is recovered all the same',
  { skip },
  async () => {
    const computer = await runningComputer(30)
    const sandbox = sandboxOf(computer)
    const hub = localHub(workspaceId)
    hub.runnerAway(computer.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(computer, 2)
    // Its runner's service start never reaches it (boat refuses, or holds it until it times out).
    // In use: not stopped as idle meanwhile.
    hub.touch(computer.id)
    await inHub(() => cloud.checkIdle(computer))
    for (let i = 0; i < 100 && hub.runnerAway(computer.id)?.unreachedSince === undefined; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    const since = hub.runnerAway(computer.id)?.unreachedSince
    assert.ok(since !== undefined)
    // boat still saves it: nothing yet, until its commands have not reached it for UNSAVED_MS.
    const before = boat.recovers.filter((r) => r === sandbox).length
    const savedAt = (at: number) =>
      boat.saved.set(sandbox, {
        verified: new Date(at - 2 * MIN),
        snapshot: new Date(at - 2 * MIN),
      })
    savedAt(since + UNSAVED_MS - MIN)
    assert.equal(await inHub(() => cloud.recoverAway(computer, since + UNSAVED_MS - MIN)), false)
    savedAt(since + UNSAVED_MS)
    assert.equal(await inHub(() => cloud.recoverAway(computer, since + UNSAVED_MS)), true)
    assert.equal(boat.recovers.filter((r) => r === sandbox).length, before + 1)
    assert.deepEqual(stopsOf(computer), [{ sandbox, force: true }])
    assert.equal(await until(computer.id, 'running'), 'running')
    // A command that reaches it, whatever it answers, ends that.
    hub.noteAwayUnreached(computer.id, Date.now())
    hub.noteAwayReached(computer.id)
    assert.equal(hub.runnerAway(computer.id)?.unreachedSince, undefined)
  },
)

test('a machine boat still saves is left as it is, its runner away or not', { skip }, async () => {
  const computer = await runningComputer(60)
  const hub = localHub(workspaceId)
  hub.runnerAway(computer.id, Date.now() - 45 * MIN)
  // Nov 7 at 11:05: a resumed machine stalled, boat's checks went on, and it came back by itself.
  savedAgo(computer, 4)
  assert.equal(await inHub(() => cloud.recoverAway(computer)), false)
  assert.deepEqual(
    boat.recovers.filter((r) => r === sandboxOf(computer)),
    [],
  )
  assert.deepEqual(stopsOf(computer), [])
  // Away for less than RECOVER_AFTER_MS: boat is not even asked what it saved.
  const fresh = await runningComputer(60)
  savedAgo(fresh, 60)
  const now = Date.now()
  hub.runnerAway(fresh.id, now)
  assert.equal(await inHub(() => cloud.recoverAway(fresh, now + RECOVER_AFTER_MS - MIN)), false)
  assert.deepEqual(stopsOf(fresh), [])
})

test(
  'a power-cycle boat accepts is waited for; a machine it reaches is left as it is',
  { skip },
  async () => {
    const hub = localHub(workspaceId)
    const recovered = await runningComputer(30)
    hub.runnerAway(recovered.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(recovered, 25)
    boat.recoverAnswer = 'accept'
    const now = Date.now()
    assert.equal(await inHub(() => cloud.recoverAway(recovered, now)), true)
    assert.equal(hub.runnerAway(recovered.id)?.recover, 'recovering')
    assert.deepEqual(stopsOf(recovered), [])
    // Not back RECOVER_WAIT_MS later, and still unsaved: stopped with its last snapshot.
    assert.equal(
      await inHub(() => cloud.recoverAway(recovered, now + RECOVER_WAIT_MS - MIN)),
      false,
    )
    assert.equal(await inHub(() => cloud.recoverAway(recovered, now + RECOVER_WAIT_MS)), true)
    assert.deepEqual(stopsOf(recovered), [{ sandbox: sandboxOf(recovered), force: true }])
    assert.equal(boat.recovers.filter((r) => r === sandboxOf(recovered)).length, 1)
    assert.equal(await until(recovered.id, 'running'), 'running')

    // A power-cycle after which boat saves the machine again, its runner still away: nothing more
    // is done, and its alert no longer says boat is power-cycling it once the wait is over.
    const cycled = await runningComputer(30)
    hub.runnerAway(cycled.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(cycled, 25)
    assert.equal(await inHub(() => cloud.recoverAway(cycled, now)), true)
    const later = now + RECOVER_WAIT_MS + 30 * MIN
    const savedAgain = new Date(later - MIN)
    boat.saved.set(sandboxOf(cycled), { verified: savedAgain, snapshot: savedAgain })
    assert.equal(await inHub(() => cloud.recoverAway(cycled, later)), false)
    assert.deepEqual(stopsOf(cycled), [])
    const detail = (at: number) =>
      computerProblem(
        { ...cycled, workspace: { name: 'recover' } },
        false,
        awayFor(hub.runnerAway(cycled.id), cycled, at),
        at,
        hub.runnerAway(cycled.id),
      )?.detail ?? ''
    assert.match(detail(now + MIN), /boat is power-cycling its machine/)
    assert.doesNotMatch(detail(later), /power-cycling/)

    // boat reaches the machine though it does not save it: nothing stopped, asked again later.
    const reached = await runningComputer(30)
    hub.runnerAway(reached.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(reached, 25)
    boat.recoverAnswer = 'sandbox_is_reachable'
    assert.equal(await inHub(() => cloud.recoverAway(reached, now)), false)
    assert.equal(await inHub(() => cloud.recoverAway(reached, now + RECOVER_WAIT_MS)), false)
    assert.equal(boat.recovers.filter((r) => r === sandboxOf(reached)).length, 1)
    assert.equal(await inHub(() => cloud.recoverAway(reached, now + RECOVER_AGAIN_MS)), false)
    assert.equal(boat.recovers.filter((r) => r === sandboxOf(reached)).length, 2)
    assert.deepEqual(stopsOf(reached), [])
  },
)

test(
  'without a snapshot to restart from, or on a full disk, moved to a new VM at once',
  { skip },
  async () => {
    const hub = localHub(workspaceId)
    const replacementOf = (computerId: string) =>
      prisma.computerReplacement.findFirst({ where: { computerId } })
    const switched = async (computerId: string) => {
      for (let i = 0; i < 200 && (await replacementOf(computerId))?.phase !== 'creating'; i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      return replacementOf(computerId)
    }
    // Never saved: no restart, which would lose its whole disk; a new VM, its old one stopped
    // without force, for the same reason.
    const never = await runningComputer(30)
    hub.runnerAway(never.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(never, null)
    assert.equal(await inHub(() => cloud.recoverAway(never)), true)
    assert.equal((await switched(never.id))?.memberId, AUTOMATIC_REPLACEMENT)
    assert.deepEqual(stopsOf(never), [{ sandbox: sandboxOf(never), force: false }])
    assert.ok(!boat.resumes.includes(sandboxOf(never)))

    // A full disk, which boat would not start again: a new VM, its old one stopped with force.
    const full = await runningComputer(30)
    await prisma.computer.update({
      where: { id: full.id },
      data: { disk: { used: 0.91, since: new Date().toISOString(), at: new Date().toISOString() } },
    })
    const row = await marked(full.id, 30)
    hub.runnerAway(full.id, Date.now() - RECOVER_AFTER_MS - MIN)
    savedAgo(full, 25)
    assert.equal(await inHub(() => cloud.recoverAway(row)), true)
    assert.equal((await switched(full.id))?.memberId, AUTOMATIC_REPLACEMENT)
    assert.deepEqual(stopsOf(full), [{ sandbox: sandboxOf(full), force: true }])
    assert.ok(!boat.resumes.includes(sandboxOf(full)))
  },
)

test('stopped on purpose, a computer is not awaited any more', { skip }, async () => {
  const hub = localHub(workspaceId)
  const computer = await runningComputer(30)
  hub.runnerAway(computer.id, Date.now() - RECOVER_AFTER_MS - MIN)
  hub.noteAwayRecover(computer.id, 'impossible')
  // Its idle stop, a member's.
  await inHub(() =>
    cloud.stopComputer(computer, { type: 'system', id: 'brigade' }, { force: true }),
  )
  assert.equal(hub.runnerAway(computer.id)?.recover, undefined)
  assert.equal(hub.runnerAway(computer.id)?.restarts, 0)
})

test('one recovery at a time for a computer', { skip }, async () => {
  const computer = await runningComputer(30)
  const hub = localHub(workspaceId)
  hub.runnerAway(computer.id, Date.now() - RECOVER_AFTER_MS - MIN)
  savedAgo(computer, 25)
  // boat's answer waits; the next minute's check comes meanwhile (Nov 18: two restarts 55
  // seconds apart, from two checks that read the computer before either changed it).
  let answer!: () => void
  boat.answering = new Promise((resolve) => (answer = resolve))
  const first = inHub(() => cloud.recoverAway(computer))
  for (let i = 0; i < 100 && !boat.recovers.includes(sandboxOf(computer)); i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  const second = inHub(() => cloud.recoverAway(computer))
  await new Promise((resolve) => setTimeout(resolve, 50))
  answer()
  boat.answering = null
  assert.equal(await second, false)
  assert.equal(await first, true)
  assert.equal(boat.recovers.filter((r) => r === sandboxOf(computer)).length, 1)
  assert.equal(stopsOf(computer).length, 1)
  assert.equal(await until(computer.id, 'running'), 'running')
})

test(
  'many computers replaced at once: boat is failing, not one machine, and it is waited out',
  { skip },
  async () => {
    const computer = await runningComputer(30)
    const hub = localHub(workspaceId)
    hub.runnerAway(computer.id, Date.now() - RECOVER_AFTER_MS - MIN)
    hub.noteAwayRestart(computer.id)
    savedAgo(computer, 25)
    // Five others replaced by Brigade in the last half hour.
    const others = await Promise.all(Array.from({ length: 5 }, () => runningComputer(30)))
    await prisma.computerReplacement.createMany({
      data: others.map((other) => ({
        organizationId,
        workspaceId,
        computerId: other.id,
        memberId: AUTOMATIC_REPLACEMENT,
        phase: 'done',
      })),
    })
    const row = await marked(computer.id, 30)
    assert.equal(await inHub(() => cloud.recoverAway(row)), false)
    assert.equal(await prisma.computerReplacement.count({ where: { computerId: computer.id } }), 0)
    assert.equal(hub.runnerAway(computer.id)?.gaveUp, undefined)
    // Asked again each minute: once they are older, it is replaced.
    await prisma.computerReplacement.updateMany({
      where: { computerId: { in: others.map((o) => o.id) } },
      data: { createdAt: new Date(Date.now() - 60 * MIN) },
    })
    assert.equal(await inHub(() => cloud.recoverAway(row)), true)
    assert.equal(await prisma.computerReplacement.count({ where: { computerId: computer.id } }), 1)
    await prisma.computerReplacement.deleteMany({
      where: { computerId: { in: others.map((o) => o.id) } },
    })
  },
)

test('an old VM being replaced is never started again', { skip }, async () => {
  const computer = await runningComputer(30)
  const sandbox = sandboxOf(computer)
  await prisma.computerReplacement.create({
    data: {
      organizationId,
      workspaceId,
      computerId: computer.id,
      memberId: AUTOMATIC_REPLACEMENT,
      phase: 'backing_up',
    },
  })
  // Its replacement stopped it, before switching it to a new VM: the minute's check would mark
  // it stopped, and start it again with a thread running (Nov 18, 23:06); so would a message.
  boat.states.set(sandbox, 'archived')
  await inHub(() => cloud.checkIdle(computer))
  await inHub(() => cloud.ensureRunning(computer.id))
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(!boat.resumes.includes(sandbox))
  assert.equal(await statusOf(computer.id), 'running')
})

test('a runner back while boat is asked is left running', { skip }, async () => {
  const computer = await runningComputer(30)
  const hub = localHub(workspaceId)
  hub.runnerAway(computer.id, Date.now() - RECOVER_AFTER_MS - MIN)
  savedAgo(computer, 25)
  // boat's answer waits; the runner says hello meanwhile.
  let answer!: () => void
  boat.answering = new Promise((resolve) => (answer = resolve))
  const recovering = inHub(() => cloud.recoverAway(computer))
  for (let i = 0; i < 100 && !boat.recovers.includes(sandboxOf(computer)); i++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  const runner = await fakeRunner({ organizationId, workspaceId }, computer.id)
  answer()
  boat.answering = null
  assert.equal(await recovering, false)
  assert.deepEqual(stopsOf(computer), [])
  assert.equal(
    (await prisma.computer.findUniqueOrThrow({ where: { id: computer.id } })).status,
    'running',
  )
  assert.ok(hub.runners.has(computer.id))
  runner.close()
})

test('a hello gives a computer its restarts back', { skip }, async () => {
  const computer = await runningComputer(30)
  const hub = localHub(workspaceId)
  hub.runnerAway(computer.id, Date.now() - 60 * MIN)
  for (let i = 0; i < RECOVER_LIMIT; i++) hub.noteAwayRestart(computer.id)
  hub.noteAwayRecover(computer.id, 'reachable')
  assert.equal(hub.runnerAway(computer.id)?.restarts, RECOVER_LIMIT)
  // Its runner connects and goes again before anything reads it online.
  const runner = await fakeRunner({ organizationId, workspaceId }, computer.id)
  const conn = hub.runners.get(computer.id)!
  hub.runners.delete(computer.id)
  hub.takeOver(conn)
  runner.close()
  const away = hub.runnerAway(computer.id)
  assert.equal(away?.restarts, 0)
  assert.equal(away?.recover, undefined)
  assert.ok(Date.now() - away!.since < MIN)
})
