// The sample workspace's missions (docs/missions.md): Maya growing Acme's LinkedIn page, with its
// routines, a draft to approve before its deadline, posts that went out and the followers she
// read; and Sam's Reddit loop, opportunistic, with no number. Added to the Acme sample once, also
// to a sample seeded before missions existed (seed.ts runs it on each preview start).
import { prisma, type Prisma } from '../src/db.js'

const DAY = 86_400_000
const ago = (ms: number) => new Date(Date.now() - ms)
const ahead = (ms: number) => new Date(Date.now() + ms)
/** A day ahead at a given hour, in UTC (14:30 Paris in winter is 13:30 UTC). */
function dayAt(days: number, hour: number, minute = 0) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  d.setUTCHours(hour, minute, 0, 0)
  return d
}

export async function seedMissions() {
  const organization = await prisma.organization.findFirst({
    where: { slug: 'acme' },
    select: { id: true },
  })
  if (!organization) return
  const workspace = await prisma.workspace.findFirst({
    where: { organizationId: organization.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!workspace) return
  if (await prisma.initiative.count({ where: { workspaceId: workspace.id } })) return
  const inWorkspace = { organizationId: organization.id, workspaceId: workspace.id }
  const [maya, sam, ada, computer, launch] = await Promise.all([
    prisma.teammate.findFirst({ where: { ...inWorkspace, name: 'Maya' } }),
    prisma.teammate.findFirst({ where: { ...inWorkspace, name: 'Sam' } }),
    prisma.member.findFirst({
      where: { organizationId: organization.id, role: 'owner' },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.computer.findFirst({ where: inWorkspace, orderBy: { createdAt: 'asc' } }),
    prisma.project.findFirst({ where: { ...inWorkspace, name: { contains: 'launch' } } }),
  ])
  if (!maya || !sam || !ada || !computer) return
  const account = await prisma.account.findFirst({
    where: { ...inWorkspace, memberId: ada.id, provider: 'claude_code' },
  })
  if (!account) return

  const thread = async (data: {
    title: string
    teammateId: string
    startedAt: Date
    initiativeId?: string
    scheduleId?: string
    parentId?: string
    origin?: 'member' | 'schedule'
    report?: Prisma.InputJsonValue
    events: { type: string; text: string; memberId?: string | null }[]
  }) => {
    const { events, startedAt, ...rest } = data
    const at = (i: number) => new Date(startedAt.getTime() + i * 53_000)
    const session = await prisma.session.create({
      data: {
        ...inWorkspace,
        ...rest,
        ...(rest.parentId ? { parentTeammateId: data.teammateId } : {}),
        status: 'idle',
        startedByMemberId: ada.id,
        computerId: computer.id,
        accountId: account.id,
        projectId: launch?.id ?? null,
        lastSeq: events.length,
        createdAt: startedAt,
        updatedAt: at(events.length),
      },
    })
    await prisma.threadTeammate.create({
      data: {
        ...inWorkspace,
        sessionId: session.id,
        teammateId: data.teammateId,
        joinedAt: startedAt,
        lastTurnAt: at(events.length),
      },
    })
    await prisma.sessionEvent.createMany({
      data: events.map((event, i) => ({
        ...inWorkspace,
        sessionId: session.id,
        seq: i + 1,
        type: event.type,
        data: {
          ...event,
          ...(event.type === 'message.done'
            ? { id: `seed-${i}`, teammateId: data.teammateId }
            : {}),
          at: at(i).toISOString(),
        } as Prisma.InputJsonValue,
        at: at(i),
      })),
    })
    return session
  }

  // ---- Maya: Acme's LinkedIn page ----
  const linkedin = await prisma.initiative.create({
    data: {
      ...inWorkspace,
      teammateId: maya.id,
      projectId: launch?.id ?? null,
      title: 'Grow Acme on LinkedIn',
      objective:
        '2,000 followers on the Acme page by January, with two posts a week and daily comments.',
      metricLabel: 'Followers',
      metricTarget: 2000,
      createdByMemberId: ada.id,
      createdAt: ago(21 * DAY),
    },
  })
  const main = await thread({
    title: 'Grow Acme’s LinkedIn page',
    teammateId: maya.id,
    startedAt: ago(21 * DAY),
    initiativeId: linkedin.id,
    events: [
      {
        type: 'message.user',
        text: 'Grow our LinkedIn page: two posts a week, comments on the posts our buyers read. I approve every post.',
        memberId: ada.id,
      },
      {
        type: 'message.done',
        text: 'On it. Comments each weekday morning, a draft for the next post each evening, and the followers read every Sunday. Each post waits for your approval before it goes out.',
      },
    ],
  })
  const routine = (title: string, cron: string, instructions: string, next: Date) =>
    prisma.schedule.create({
      data: {
        ...inWorkspace,
        teammateId: maya.id,
        title,
        instructions,
        cron,
        timezone: 'Europe/Paris',
        ownerMemberId: ada.id,
        createdByTeammateId: maya.id,
        projectId: launch?.id ?? null,
        parentSessionId: main.id,
        initiativeId: linkedin.id,
        nextRunAt: next,
        createdAt: ago(20 * DAY),
      },
    })
  const comments = await routine(
    'Morning comments',
    '30 9 * * 1-5',
    'Comment on three posts our buyers read this morning, in Acme’s voice. Record each comment.',
    dayAt(1, 8, 30),
  )
  await routine(
    'Evening: draft tomorrow’s post',
    '30 21 * * 0-3',
    'Draft the next post and plan it with plan_action, with its draft for Ada to approve.',
    dayAt(0, 20, 30),
  )
  await routine(
    'Sunday: followers and the week',
    '0 17 * * 0',
    'Read the followers in LinkedIn analytics, record_number them, and sum up the week.',
    dayAt((7 - new Date().getUTCDay()) % 7 || 7, 16),
  )
  await thread({
    title: 'Morning comments · yesterday',
    teammateId: maya.id,
    startedAt: ago(DAY + 2 * 3_600_000),
    origin: 'schedule',
    scheduleId: comments.id,
    parentId: main.id,
    report: {
      status: 'report',
      summary: 'Three comments, on posts about per-seat billing; one reply from a CFO.',
      at: ago(DAY).toISOString(),
    },
    events: [{ type: 'message.done', text: 'Three comments posted and recorded.' }],
  })

  // Its plan: a post that went out, one approved, and one whose draft waits for Ada.
  const fired = await prisma.initiativeAction.create({
    data: {
      ...inWorkspace,
      initiativeId: linkedin.id,
      sessionId: main.id,
      teammateId: maya.id,
      title: 'Post: one invoice per seat',
      instructions: 'Publish the approved post on the Acme page, then record it.',
      draft: 'One invoice, per seat. No more chasing five receipts at month end…',
      dueAt: ago(2 * DAY),
      approveBy: ago(2 * DAY + 15 * 60_000),
      status: 'fired',
      decidedByMemberId: ada.id,
      decidedAt: ago(3 * DAY),
      firedAt: ago(2 * DAY),
      createdAt: ago(3 * DAY),
    },
  })
  await prisma.initiativeAction.create({
    data: {
      ...inWorkspace,
      initiativeId: linkedin.id,
      sessionId: main.id,
      teammateId: maya.id,
      title: 'Post: invite your team in one click',
      instructions: 'Publish the approved post on the Acme page, then record it.',
      draft: 'Inviting your whole team used to take an afternoon. Now it takes one click…',
      dueAt: dayAt(3, 13, 30),
      approveBy: dayAt(3, 13, 15),
      status: 'planned',
      decidedByMemberId: ada.id,
      decidedAt: ago(3_600_000),
      createdAt: ago(5 * 3_600_000),
    },
  })
  const waiting = await prisma.initiativeAction.create({
    data: {
      ...inWorkspace,
      initiativeId: linkedin.id,
      sessionId: main.id,
      teammateId: maya.id,
      title: 'Post: owners, admins, members',
      instructions: 'Publish the approved post on the Acme page, then record it.',
      draft:
        'Who can change billing? Who can invite? With Acme Teams, three roles answer it: owners, admins, members.\n\nRoles ship today for every plan.',
      dueAt: dayAt(1, 13, 30),
      approveBy: dayAt(1, 13, 15),
      status: 'awaiting_approval',
      createdAt: ago(2 * 3_600_000),
    },
  })
  const ticket = await prisma.ticket.create({
    data: {
      ...inWorkspace,
      sessionId: main.id,
      type: 'approval',
      title: 'Maya: approve "Post: owners, admins, members"',
      payload: {
        missionAction: {
          actionId: waiting.id,
          missionId: linkedin.id,
          mission: linkedin.title,
          title: waiting.title,
          dueAt: waiting.dueAt.toISOString(),
          approveBy: waiting.approveBy!.toISOString(),
        },
        draft: waiting.draft!,
        teammateId: maya.id,
      },
      createdAt: waiting.createdAt,
    },
  })
  await prisma.initiativeAction.update({ where: { id: waiting.id }, data: { ticketId: ticket.id } })

  await prisma.initiativeOutput.createMany({
    data: [
      {
        ...inWorkspace,
        initiativeId: linkedin.id,
        sessionId: main.id,
        teammateId: maya.id,
        actionId: fired.id,
        kind: 'post',
        channel: 'linkedin',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:0000000000000000001/',
        summary: 'One invoice, per seat',
        at: ago(2 * DAY),
        metrics: { impressions: 3120, reactions: 64, comments: 9 },
        metricsAt: ago(3 * 3_600_000),
      },
      {
        ...inWorkspace,
        initiativeId: linkedin.id,
        sessionId: main.id,
        teammateId: maya.id,
        kind: 'comment',
        channel: 'linkedin',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:0000000000000000002/',
        summary: 'Comment on a CFO’s post about month-end receipts',
        at: ago(DAY + 3_600_000),
        metrics: { reactions: 12 },
        metricsAt: ago(5 * 3_600_000),
      },
      {
        ...inWorkspace,
        initiativeId: linkedin.id,
        sessionId: main.id,
        teammateId: maya.id,
        kind: 'post',
        channel: 'linkedin',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:0000000000000000003/',
        summary: 'Meet Acme Teams',
        at: ago(6 * DAY),
        metrics: { impressions: 5480, reactions: 121, comments: 17 },
        metricsAt: ago(2 * DAY),
      },
    ],
  })
  await prisma.initiativeValue.createMany({
    data: [1180, 1214, 1236, 1290, 1344, 1371, 1402, 1458].map((value, i, all) => ({
      ...inWorkspace,
      initiativeId: linkedin.id,
      teammateId: maya.id,
      value,
      note: 'LinkedIn analytics, followers',
      at: ago((all.length - i) * 3 * DAY + DAY),
    })),
  })

  // ---- Sam: the Reddit loop, opportunistic, with no number ----
  const reddit = await prisma.initiative.create({
    data: {
      ...inWorkspace,
      teammateId: sam.id,
      projectId: launch?.id ?? null,
      title: 'Answer invoicing questions on Reddit',
      objective:
        'Help where people ask about team invoicing, saying Sam is Acme’s AI, never as a fake user.',
      createdByMemberId: ada.id,
      createdAt: ago(10 * DAY),
    },
  })
  const loop = await thread({
    title: 'Reddit: invoicing questions',
    teammateId: sam.id,
    startedAt: ago(10 * DAY),
    initiativeId: reddit.id,
    events: [
      {
        type: 'message.user',
        text: 'Look for Reddit threads where people ask how to invoice a team, and answer the good ones. Ask me before anything that mentions Acme.',
        memberId: ada.id,
      },
      {
        type: 'message.done',
        text: 'Set up: a pass each weekday at 9:00. I will show you each answer that names Acme before it goes.',
      },
    ],
  })
  await prisma.schedule.create({
    data: {
      ...inWorkspace,
      teammateId: sam.id,
      title: 'Reddit loop',
      instructions:
        'Search r/smallbusiness and r/SaaS for new questions about invoicing a team. Answer the good ones; record each answer.',
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Paris',
      ownerMemberId: ada.id,
      createdByTeammateId: sam.id,
      projectId: launch?.id ?? null,
      parentSessionId: loop.id,
      initiativeId: reddit.id,
      nextRunAt: dayAt(1, 8),
      createdAt: ago(10 * DAY),
    },
  })
  await prisma.wakeup.create({
    data: {
      ...inWorkspace,
      sessionId: loop.id,
      teammateId: sam.id,
      note: 'See whether the r/SaaS thread on per-seat invoices got answers worth replying to.',
      wakeAt: ahead(26 * 3_600_000),
    },
  })
  await prisma.initiativeOutput.create({
    data: {
      ...inWorkspace,
      initiativeId: reddit.id,
      sessionId: loop.id,
      teammateId: sam.id,
      kind: 'reply',
      channel: 'reddit r/smallbusiness',
      url: 'https://www.reddit.com/r/smallbusiness/comments/example/',
      summary: 'How to split one SaaS invoice across five teammates',
      at: ago(DAY + 5 * 3_600_000),
      metrics: { upvotes: 14, replies: 3 },
      metricsAt: ago(4 * 3_600_000),
    },
  })
  console.log('created: sample missions (Maya on LinkedIn, Sam on Reddit)')
}
