// The Chief runs on a login its workspace's owner has. Onboarding moves it to Codex when that is
// the owner's or admin's only login, but only while its page is open as the login turns ready: a
// Mac's own Codex login, found by the runner minutes after the Mac was linked, came once the page
// was closed, and that person met a Chief on Claude Code that nothing could start ("No Claude Code
// account"). This does what onboarding's finish does, whenever such a login turns ready.
import { usableBy } from './account-sharing.js'
import { audit } from './audit.js'
import { prisma } from './db.js'

/** Logins whose accounts count, as onboarding's (a login expiring later opens a ticket). */
const WORKS = ['ready', 'unverified', 'exhausted'] as const

/**
 * As onboarding's finish, for the member whose login just turned ready: the owner of a workspace
 * with no teammate but its Chief, whose Chief has never been in a thread (its own or one it was
 * called into) and runs on Claude Code or Codex, while the owner may run on the other login and
 * nobody in the workspace has an account of the Chief's. The Chief moves to that login, with its
 * default model. Only the owner's login moves it: anyone else's is theirs alone, and found first
 * it would leave the owner a Chief they cannot run. Nor does it move back once someone has an
 * account of its login, so two people's logins never take it in turns. True when it moved.
 */
export async function alignChief(workspaceId: string, memberId: string): Promise<boolean> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, removingAt: null },
    select: { role: true },
  })
  if (member?.role !== 'owner') return false
  const team = await prisma.teammate.findMany({
    where: { workspaceId, archivedAt: null },
    select: { id: true, kind: true, organizationId: true, harness: true, model: true },
  })
  const chief = team.find((t) => t.kind === 'chief')
  // A team set up already: its owner chose what it runs on.
  if (!chief || team.length > 1) return false
  if (chief.harness !== 'claude_code' && chief.harness !== 'codex') return false
  const harness = chief.harness === 'codex' ? 'claude_code' : 'codex'
  const theirs = await prisma.account.count({
    where: {
      workspaceId,
      AND: [usableBy(memberId)],
      provider: harness,
      status: { in: [...WORKS] },
    },
  })
  if (theirs === 0) return false
  // Nobody's account of the Chief's login works: a thread starting on it now is refused.
  const kept = { provider: chief.harness, status: { in: [...WORKS] } }
  if ((await prisma.account.count({ where: { workspaceId, ...kept } })) > 0) return false
  // In one statement: only as it was read, while it is in no committed thread and no account of
  // its login works, so a person changing it, or an account of its login turning ready, wins. A
  // thread that picked such an account just before it stopped working can still start on it.

  const { count } = await prisma.teammate.updateMany({
    where: {
      id: chief.id,
      harness: chief.harness,
      model: chief.model,
      sessions: { none: {} },
      threadSeats: { none: {} },
      workspace: { accounts: { none: kept } },
    },
    data: { harness, model: null },
  })
  if (count === 0) return false
  await audit({
    organizationId: chief.organizationId,
    workspaceId,
    actor: { type: 'system', id: 'brigade' },
    action: 'teammate.updated',
    target: { type: 'teammate', id: chief.id },
    data: { fields: ['harness', 'model'], harness, reason: 'only_login', memberId },
  })
  return true
}
