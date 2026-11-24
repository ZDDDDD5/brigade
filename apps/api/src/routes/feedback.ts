// Give feedback (the sidebar's line): a member's words and files, stored in Feedback with the
// page they were on, then mailed to Brigade's team (FEEDBACK_EMAILS, else OPS_ALERT_EMAILS).
// Files are uploaded first like a message's (POST /attachments/uploads); sent with feedback,
// they stay with it and are never swept as unsent uploads.
import { SendFeedback } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { audit } from '../audit.js'
import { attachmentKey, directUploads, presignGet } from '../bucket.js'
import { env } from '../config.js'
import { prisma, type ScopedDb } from '../db.js'
import { UNSENT_MS } from '../attachments.js'
import { addressOf } from '../mail/names.js'
import { resendConfigured, sendEmail } from '../mail/resend.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

/** Files larger than this are only linked in the mail, not attached; Resend takes 40 MB in all. */
const ATTACH_EACH = 10 * 1024 * 1024
const ATTACH_TOTAL = 30 * 1024 * 1024
/** Long enough for Resend to fetch them, however long its queue. */
const ATTACH_SECONDS = 24 * 3600
/** The files' links in the mail's text: as long as R2 signs one. */
const LINK_DAYS = 7

/** What one member may send, so a loop or a stuck key cannot flood the team or Resend. */
export const FEEDBACK_LIMITS = { burst: 5, burstMs: 10 * 60_000, day: 30 } as const
/** Feedback mailed per hour across Brigade; past it, feedback is stored but not mailed. */
const MAILS_PER_HOUR = 100

export const feedback = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)
  .post('/', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, SendFeedback)
    const ids = [...new Set(input.attachmentIds)]

    // Bounded before anything is written or mailed.
    const now = Date.now()
    const [recent, today] = await Promise.all([
      db.feedback.count({
        where: {
          memberId: scope.memberId,
          createdAt: { gt: new Date(now - FEEDBACK_LIMITS.burstMs) },
        },
      }),
      db.feedback.count({
        where: { memberId: scope.memberId, createdAt: { gt: new Date(now - 24 * 3600_000) } },
      }),
    ])
    if (recent >= FEEDBACK_LIMITS.burst || today >= FEEDBACK_LIMITS.day)
      throw new HTTPException(429, {
        message: 'You sent a lot of feedback just now: try again a little later',
      })

    const row = await db.feedback.create({
      data: {
        memberId: scope.memberId,
        userId: scope.userId,
        text: input.text,
        page: input.page.slice(0, 2000),
        userAgent: (c.req.header('user-agent') ?? '').slice(0, 500),
      } as never,
    })
    let files: { id: string; name: string; size: number; contentType: string }[] = []
    if (ids.length) {
      try {
        files = await claimUploads(db, scope.memberId, row.id, ids, now)
      } catch (error) {
        await db.feedback.deleteMany({ where: { id: row.id } })
        throw error
      }
    }
    await audit({
      ...scope,
      actor: { type: 'member', id: scope.memberId },
      action: 'feedback.sent',
      target: { type: 'feedback', id: row.id },
      data: { files: ids.length },
    })

    const mailed = await prisma.feedback.count({
      where: { createdAt: { gt: new Date(now - 3600_000) } },
    })
    if (mailed > MAILS_PER_HOUR) {
      console.warn(`feedback ${row.id}: stored, not mailed (over ${MAILS_PER_HOUR} an hour)`)
      return c.json({ id: row.id }, 201)
    }
    // The mail is a copy: the feedback is stored either way, so a failure here is only logged.
    await mailTeam(scope, row, files).catch((error) =>
      console.warn(`feedback ${row.id}: not mailed: ${String(error)}`),
    )
    return c.json({ id: row.id }, 201)
  })

/**
 * Give the member's own unsent uploads to a feedback, all or none. Each file is taken by one
 * conditional write, so of two sends racing for a file only one gets it, and a Cancel (DELETE
 * /attachments/:id, which deletes only a file nothing took) either wins before or finds it
 * taken. Only uploads well inside UNSENT_MS are taken: older ones may be under sweepUploads.
 * When any is missing, those taken are given back and it throws.
 */
export async function claimUploads(
  db: ScopedDb,
  memberId: string,
  feedbackId: string,
  ids: string[],
  now = Date.now(),
) {
  const where = {
    id: { in: ids },
    source: 'upload' as const,
    status: 'ready' as const,
    uploadedByMemberId: memberId,
    threads: { none: {} },
    createdAt: { gt: new Date(now - UNSENT_MS + 3600_000) },
  }
  const taken = await db.attachment.updateMany({
    where: { ...where, feedbackId: null },
    data: { feedbackId },
  })
  if (taken.count !== ids.length) {
    await db.attachment.updateMany({ where: { feedbackId }, data: { feedbackId: null } })
    throw new HTTPException(400, { message: 'An attached file was not found or was already sent' })
  }
  return db.attachment.findMany({
    where: { id: { in: ids }, feedbackId },
    select: { id: true, name: true, size: true, contentType: true },
  })
}

async function mailTeam(
  scope: { organizationId: string; workspaceId: string; userId: string },
  row: { id: string; text: string; page: string; userAgent: string },
  files: { id: string; name: string; size: number; contentType: string }[],
) {
  const to = env.FEEDBACK_EMAILS.length ? env.FEEDBACK_EMAILS : env.OPS_ALERT_EMAILS
  const [user, organization, workspace] = await Promise.all([
    prisma.user.findUnique({ where: { id: scope.userId }, select: { name: true, email: true } }),
    prisma.organization.findUnique({
      where: { id: scope.organizationId },
      select: { name: true },
    }),
    prisma.workspace.findUnique({ where: { id: scope.workspaceId }, select: { name: true } }),
  ])
  const who = user ? `${user.name || user.email} <${user.email}>` : scope.userId
  const page = row.page ? `${env.WEB_URL[0]}${row.page.startsWith('/') ? '' : '/'}${row.page}` : ''

  // Each file by a signed link of the bucket (the longest R2 signs: 7 days), and attached when
  // small enough, Resend fetching it by a signed link too. Without R2 (locally): names only.
  const attachments: { filename: string; path: string; content_type?: string }[] = []
  const lines: string[] = []
  let total = 0
  for (const file of files) {
    const label = `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`
    if (!directUploads) {
      lines.push(`- ${label}`)
      continue
    }
    const link = (seconds: number) =>
      presignGet(
        attachmentKey(scope, file.id),
        {
          contentType: file.contentType,
          disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        },
        seconds,
      ).then((signed) => signed.url)
    lines.push(`- ${label}: ${await link(LINK_DAYS * 24 * 3600)}`)
    if (file.size <= ATTACH_EACH && total + file.size <= ATTACH_TOTAL) {
      total += file.size
      attachments.push({
        filename: file.name,
        path: await link(ATTACH_SECONDS),
        content_type: file.contentType,
      })
    }
  }

  const text = [
    row.text,
    '',
    '---',
    `From: ${who}`,
    `Workspace: ${workspace?.name ?? '?'} (${organization?.name ?? '?'}, ${scope.workspaceId})`,
    page && `Page: ${page}`,
    row.userAgent && `Browser: ${row.userAgent}`,
    files.length
      ? `Files (links work ${LINK_DAYS} days; the files stay in Brigade):\n${lines.join('\n')}`
      : '',
    `Feedback: ${row.id}`,
  ]
    .filter((line) => line !== '')
    .join('\n')

  // Locally and in previews no mail leaves: it is in the API's log.
  if (!resendConfigured() || to.length === 0)
    return console.log(`feedback ${row.id} from ${who}:\n${text}`)
  const first = row.text.split('\n')[0]!.slice(0, 80)
  await sendEmail(
    {
      from: `Brigade feedback <${addressOf('feedback')}>`,
      to,
      ...(user?.email ? { reply_to: [user.email] } : {}),
      subject: `Feedback: ${first}`,
      text,
      ...(attachments.length ? { attachments } : {}),
    },
    `brigade-feedback-${row.id}`,
  )
}
