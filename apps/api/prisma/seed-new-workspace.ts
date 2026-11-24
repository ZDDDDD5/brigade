// A workspace just past onboarding, for a local Brigade or a preview: Erin's, with an AI account
// on its cloud computer, its Getting started list and Chief alone, which has no thread yet. Its
// threads page opens on Chief's first meeting (apps/web/components/first-meeting.tsx), as a new
// workspace's owner sees it once onboarding ends; no runner answers what is sent there.
// With a Cloud plan, so its cloud computer counts as one to start threads on when billing is on.
// Called by seed.ts while Erin has no workspace, or one without its plan.
import { randomUUID } from 'node:crypto'
import { CHIEF_NAME } from '@brigade/contracts'
import { prisma } from '../src/db.js'
import { seedGettingStarted } from '../src/lists.js'

export async function seedNewWorkspace(erin: { id: string; email: string }) {
  const made = await prisma.workspace.findFirst({
    where: { organization: { members: { some: { userId: erin.id } } } },
    select: { id: true },
  })
  if (made) return await cloudPlan(made.id)
  const organization = await prisma.organization.create({
    data: { id: randomUUID(), name: 'Erin', slug: `erin-${randomUUID().slice(0, 4)}` },
  })
  const organizationId = organization.id
  const member = await prisma.member.create({
    data: { id: randomUUID(), organizationId, userId: erin.id, role: 'owner' },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId, name: 'Erin’s workspace' },
  })
  const inWorkspace = { organizationId, workspaceId: workspace.id }
  // No runner answers in a preview: the cloud computer shows stopped, and threads can start.
  const computer = await prisma.computer.create({
    data: {
      ...inWorkspace,
      kind: 'cloud',
      name: 'Erin’s cloud',
      size: 'standard',
      status: 'stopped',
    },
  })
  await prisma.account.create({
    data: {
      ...inWorkspace,
      memberId: member.id,
      computerId: computer.id,
      provider: 'claude_code',
      source: 'brigade',
      label: `Claude (${erin.email})`,
      email: erin.email,
      plan: 'max',
      status: 'ready',
      isDefault: true,
    },
  })
  await prisma.teammate.create({ data: { ...inWorkspace, name: CHIEF_NAME, kind: 'chief' } })
  // What onboarding's questions kept: said under the first message to Chief.
  await prisma.user.update({
    where: { id: erin.id },
    data: {
      onboardingAnswers: {
        role: { id: 'founder', position: 1 },
        teamSize: { id: 'solo', position: 1 },
        firstWork: { id: 'marketing', position: 2 },
      },
    },
  })
  await cloudPlan(workspace.id)
  await seedGettingStarted(inWorkspace).catch((error: unknown) =>
    console.warn(`seed: no getting-started list for Erin: ${String(error)}`),
  )
  console.log('created: Erin’s new workspace')
}

/** An active Cloud plan, without Stripe: a preview has billing on, with no webhook to make one. */
async function cloudPlan(workspaceId: string) {
  if (await prisma.billingSubscription.count({ where: { workspaceId } })) return
  await prisma.billingSubscription.create({
    data: {
      workspaceId,
      plan: 'cloud',
      tier: 'cloud',
      status: 'active',
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    },
  })
}
