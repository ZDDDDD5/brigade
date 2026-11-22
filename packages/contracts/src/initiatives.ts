// Missions (docs/missions.md): ongoing work a member delegates to a teammate, behind the
// `missions` feature. In code and in the database a mission is an Initiative, so it can't be
// taken for the Tasks board's old "mission" (Task.parentId, legacy-tasks.ts), as Snooze kept
// `Later` in code. People only ever read "Mission".
//
// A mission owns threads and routines. Its plan is data Brigade runs (planned actions, each
// prompted into its thread at its time, a draft first approved by a person before a deadline),
// and what went out is data too (outputs, with their link and numbers). Its agenda is its
// routines' next runs, its threads' wake-ups and its planned actions.
import { z } from 'zod'

/** Planned actions a mission may hold at once that have not run. */
export const ACTIONS_PER_MISSION = 30
/** An action is planned at least this far ahead: the minute's job prompts it. */
export const ACTION_MIN_MINUTES = 2
/** And at most this far: further plans belong in the mission's files, not its agenda. */
export const ACTION_MAX_DAYS = 31
/** A person has at least this long to approve a draft before its deadline. */
export const APPROVAL_MIN_MINUTES = 5
/** Days the This week view covers. */
export const WEEK_DAYS = 7

const Text = (max: number) => z.string().trim().min(1).max(max)
const Instant = z.string().max(100)

/** What went out: a post, a comment, a reply, an article, an email, or anything else. */
export const OutputKind = z.enum(['post', 'comment', 'reply', 'article', 'email', 'other'])
export type OutputKind = z.infer<typeof OutputKind>

/** An output's numbers, as read where it went out: views, likes, comments, clicks… */
export const OutputMetrics = z.record(z.string().trim().min(1).max(40), z.number().finite())
export type OutputMetrics = z.infer<typeof OutputMetrics>

/** The number a mission follows: its name, its unit, where it aims. */
export const MissionMetric = z.object({
  label: Text(60),
  unit: z.string().trim().max(20).nullish(),
  target: z.number().finite().nullish(),
})
export type MissionMetric = z.infer<typeof MissionMetric>

const MissionTitle = Text(120)
const Objective = Text(500)

/** Threads a mission is given at once, from the dashboard. */
export const MISSION_THREADS_MAX = 20

/** A mission made from the Missions page (POST /missions). */
export const CreateMission = z.object({
  title: MissionTitle,
  objective: Objective,
  /** Its owner, the teammate it is delegated to. */
  teammateId: z.string().min(1),
  projectId: z.string().nullish(),
  metric: MissionMetric.nullish(),
  /** Threads it gathers, at the top: their routines and sub-threads come with them. */
  threadIds: z.array(z.string().min(1)).max(MISSION_THREADS_MAX).default([]),
})
export type CreateMission = z.infer<typeof CreateMission>

/** Changes to a mission (PATCH /missions/:id); `threadIds` is its whole set of threads. */
export const UpdateMission = z.object({
  title: MissionTitle.optional(),
  objective: Objective.optional(),
  teammateId: z.string().min(1).optional(),
  metric: MissionMetric.nullable().optional(),
  threadIds: z.array(z.string().min(1)).max(MISSION_THREADS_MAX).optional(),
  archived: z.boolean().optional(),
})
export type UpdateMission = z.infer<typeof UpdateMission>

/** The mission operations of a teammate's schedule tools, from a thread of a mission. */
export const InitiativeOperations = [
  /** From a thread a person started, at the top: the work delegated there becomes a mission. */
  z.object({
    name: z.literal('create_mission'),
    title: MissionTitle,
    objective: Objective,
    metric: MissionMetric.optional(),
  }),
  /** Its title, objective or number changed, or archived once the work is over. */
  z.object({
    name: z.literal('update_mission'),
    title: MissionTitle.optional(),
    objective: Objective.optional(),
    metric: MissionMetric.nullable().optional(),
    archive: z.boolean().optional(),
  }),
  z.object({
    name: z.literal('plan_action'),
    /** When it runs: an ISO 8601 instant with its offset. */
    at: Instant,
    /** What it is, in a few words: "LinkedIn post: why routines". */
    title: Text(200),
    /** What to do then, the prompt the thread gets at its time. */
    instructions: Text(10_000),
    /** The text a person approves before it goes, when it needs approval. */
    draft: Text(20_000).optional(),
    /** With a draft: approved by then, or it does not go. Default: 15 minutes before `at`. */
    approveBy: Instant.optional(),
  }),
  z.object({ name: z.literal('list_actions') }),
  z.object({ name: z.literal('cancel_action'), actionId: z.string() }),
  z.object({
    name: z.literal('record_output'),
    /** Its numbers later: the output to update, and nothing else is needed. */
    outputId: z.string().optional(),
    kind: OutputKind.optional(),
    /** Where it went out: "linkedin", "x", "reddit r/selfhosted", "blog". */
    channel: Text(100).optional(),
    url: z.url().max(2_000).optional(),
    /** What it was, in a line. */
    summary: Text(500).optional(),
    /** When it went out (ISO 8601); default now. */
    at: Instant.optional(),
    /** The planned action it carried out, if any. */
    actionId: z.string().optional(),
    metrics: OutputMetrics.optional(),
  }),
  z.object({
    name: z.literal('record_number'),
    value: z.number().finite(),
    /** Where it was read: "LinkedIn analytics, followers". */
    note: Text(300).optional(),
  }),
] as const

/** A planned action's state. */
export const ActionStatus = z.enum([
  /** It runs at its time: it needs no approval, or a person approved its draft. */
  'planned',
  /** Its draft waits for a person's approval, before its deadline. */
  'awaiting_approval',
  'declined',
  /** Nobody approved its draft before the deadline: it does not go. */
  'expired',
  /** Prompted into its thread at its time. */
  'fired',
  'cancelled',
])
export type ActionStatus = z.infer<typeof ActionStatus>

/** When an action runs, and when its draft must be approved, or why it cannot be planned. */
export function actionTimes(
  input: { at: string; approveBy?: string | undefined; draft?: string | undefined },
  now = new Date(),
): { at: Date; approveBy: Date | null } | string {
  const at = new Date(input.at)
  if (Number.isNaN(at.getTime())) return `"${input.at}" is not an ISO 8601 time`
  if (at.getTime() < now.getTime() + ACTION_MIN_MINUTES * 60_000 - 1_000)
    return `An action is planned at least ${ACTION_MIN_MINUTES} minutes from now; do it now instead`
  if (at.getTime() > now.getTime() + ACTION_MAX_DAYS * 86_400_000)
    return `An action is planned at most ${ACTION_MAX_DAYS} days ahead`
  if (!input.draft) {
    if (input.approveBy) return 'approveBy goes with a draft to approve'
    return { at, approveBy: null }
  }
  const approveBy = input.approveBy
    ? new Date(input.approveBy)
    : new Date(at.getTime() - 15 * 60_000)
  if (Number.isNaN(approveBy.getTime())) return `"${input.approveBy}" is not an ISO 8601 time`
  if (approveBy.getTime() > at.getTime()) return 'approveBy comes before the action, or at it'
  if (approveBy.getTime() < now.getTime() + APPROVAL_MIN_MINUTES * 60_000 - 1_000)
    return (
      `A person needs at least ${APPROVAL_MIN_MINUTES} minutes to approve: set approveBy (and the ` +
      'action) later, or ask them in your reply now'
    )
  return { at, approveBy }
}

/** The sourceId of a wake-up an action brings to its thread: `action:<id>:<kind>`. */
export const ACTION_SOURCE = 'action:'
export type ActionNoteKind = 'run' | 'declined' | 'expired'
export const actionSourceId = (actionId: string, kind: ActionNoteKind) =>
  `${ACTION_SOURCE}${actionId}:${kind}`

/** The prompt a planned action brings to its thread at its time (src/initiatives.ts in the API). */
export function actionMessage(a: {
  mission: string
  title: string
  instructions: string
  /** The draft a person approved, and who. */
  draft?: string | null
  approvedBy?: string | null
  lateMinutes?: number
}) {
  return [
    `[Brigade mission action] "${a.title}", planned for the mission "${a.mission}"` +
      (a.lateMinutes ? `, ${a.lateMinutes} minutes late (the computer was offline)` : '') +
      '. It is due now: do it.',
    '',
    a.instructions,
    ...(a.draft
      ? [
          '',
          `The draft ${a.approvedBy ? `${a.approvedBy} approved` : 'approved'}, to use as it is:`,
          '',
          a.draft,
        ]
      : []),
    '',
    'Once it is out, record it with record_output (its link, with this action’s id). If it could not ' +
      'be done, say why in one line.',
  ].join('\n')
}

/** What a thread is told when a person declines an action's draft, or nobody approved it in time. */
export function actionDroppedMessage(a: {
  title: string
  kind: 'declined' | 'expired'
  by?: string | null
  reason?: string | null
}) {
  return (
    `[Brigade mission action] "${a.title}" will not go: ` +
    (a.kind === 'declined'
      ? `${a.by ?? 'a person'} declined its draft${a.reason ? ` ("${a.reason}")` : ''}.`
      : 'nobody approved its draft before its deadline.') +
    ' Plan it again with a new draft if it still makes sense; otherwise leave it. Say nothing to the ' +
    'person unless you plan something new.'
  )
}

const ACTION_NOTE = /^\[Brigade mission action\] "(.*?)"/

/** An action's note read back, for the dashboard: its title; null for any other text. */
export function actionNote(text: string) {
  const m = ACTION_NOTE.exec(text)
  return m ? { title: m[1]! } : null
}

// ---- What the dashboard shows (GET /missions, GET /missions/week) ----

export type MissionNumber = {
  label: string
  unit: string | null
  target: number | null
  /** goal: measured by a goal of one of its threads (docs/goals.md); declared: the teammate's word. */
  source: 'goal' | 'declared'
  /** Oldest first, the last 30 days. */
  series: { at: string; value: number }[]
}

export type MissionAgendaKind = 'routine' | 'wakeup' | 'action' | 'approval'

export type MissionAgendaItem = {
  key: string
  kind: MissionAgendaKind
  at: string
  title: string
  missionId: string
  /** Where it happens: the thread to open. */
  threadId: string | null
  teammate: { id: string; name: string } | null
  /** An approval's ticket, and the action it decides. */
  ticketId?: string
  actionId?: string
  /** An action's state. */
  status?: ActionStatus
  draft?: string | null
}

export type MissionNeed = {
  /** The thread that waits, and what for (the Board's reason). */
  threadId: string | null
  title: string
  reason: string
  /** A draft to approve: its ticket, its text and its deadline. */
  ticketId?: string
  draft?: string | null
  at?: string | null
}

export type MissionOutput = {
  id: string
  kind: OutputKind
  channel: string
  url: string | null
  summary: string
  at: string
  metrics: OutputMetrics
  metricsAt: string | null
  teammate: { id: string; name: string } | null
}

export type MissionRow = {
  id: string
  title: string
  objective: string
  teammate: { id: string; name: string }
  /** The member whose mission it is: only they change it, an admin may archive it. */
  memberId: string | null
  /** The number it follows, as set (number is what was read of it). */
  metric: { label: string; unit: string | null; target: number | null } | null
  projectId: string | null
  threads: { id: string; title: string; status: string }[]
  routines: { id: string; title: string; nextRunAt: string | null; pausedAt: string | null }[]
  number: MissionNumber | null
  next: MissionAgendaItem | null
  needs: MissionNeed[]
  /** Its latest output: what went out, never a routine's own report. */
  last: { kind: 'output'; output: MissionOutput } | null
  outputs: MissionOutput[]
  /** What went out in the last 7 days, by kind. */
  week: { outputs: number; byKind: Partial<Record<OutputKind, number>> }
  archivedAt: string | null
}

export type MissionWeek = {
  from: string
  to: string
  items: MissionAgendaItem[]
  missions: { id: string; title: string }[]
}
