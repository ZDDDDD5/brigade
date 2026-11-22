// The Chief runs on a login its workspace has. Onboarding moves it to Codex when that is the only
// login there, but only while its page is open as the login turns ready: a Mac's own Codex login,
// found by the runner minutes after the Mac was linked, came once the page was closed, and that
// person met a Chief on Claude Code that nothing could start ("No Claude Code account").
import { audit } from './audit.js'
import { prisma } from './db.js'

/** Logins whose accounts count, as onboarding's (a login expiring later opens a ticket). */
const WORKS = ['ready', 'unverified', 'exhausted'] as const

/**
 * A Chief that never ran, on Claude Code or Codex, while its workspace has ready accounts of the
 * other login only: it moves to that one, with the login's default model. One that ran keeps
 * what it runs on, as does one on Pi or Antigravity. True when it moved.
 */
export async function alignChief(workspaceId: string): Promise<boolean> {
  const chief = await prisma.teammate.findFirst({
    where: { workspaceId, kind: 'chief', archivedAt: null },
    select: { id: true, organizationId: true, harness: true, model: true },
  })
  if (!chief || (chief.harness !== 'claude_code' && chief.harness !== 'codex')) return false
  const ready = await prisma.account.findMany({
    where: { workspaceId, provider: { in: ['claude_code', 'codex'] }, status: { in: [...WORKS] } },
    select: { provider: true },
    orderBy: { createdAt: 'asc' },
  })
  const other = ready.find((a) => a.provider !== chief.harness)
  if (!other || ready.some((a) => a.provider === chief.harness)) return false
  if ((await prisma.session.count({ where: { teammateId: chief.id } })) > 0) return false
  const harness = other.provider as 'claude_code' | 'codex'
  // Only as it was read: a person changing it meanwhile wins.
  const { count } = await prisma.teammate.updateMany({
    where: { id: chief.id, harness: chief.harness, model: chief.model },
    data: { harness, model: null },
  })
  if (count === 0) return false
  await audit({
    organizationId: chief.organizationId,
    workspaceId,
    actor: { type: 'system', id: 'brigade' },
    action: 'teammate.updated',
    target: { type: 'teammate', id: chief.id },
    data: { fields: ['harness', 'model'], harness, reason: 'only_login' },
  })
  return true
}
