'use client'
// Missions (docs/missions.md), behind the `missions` feature: ongoing work a member delegated to
// a teammate. Missions shows one row per mission (its objective and number, what waits on the
// member, what comes next, what went out last); This week, the agenda across missions: routines'
// runs, wake-ups, planned actions and the drafts to approve before their deadline.
// The API computes both (GET /missions, GET /missions/week).
import type {
  MissionAgendaItem,
  MissionNumber,
  MissionOutput,
  MissionRow,
  MissionWeek,
} from '@brigade/contracts'
import {
  AlarmClock,
  Archive,
  CalendarClock,
  ChevronRight,
  ExternalLink,
  Pencil,
  Plus,
  Send,
  Stamp,
} from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { TeammateAvatar, timeAgo, useDashboard } from '@/components/dashboard'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { shortWakeTime } from '@/components/wakeup-icon'
import { api, isList, useApi, type ThreadSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

/** What changes a mission: its threads, tickets and routines. */
const LIVE = ['thread.updated', 'tickets.updated', 'schedule.updated'] as const

type View = 'missions' | 'week'
const VIEWS: { value: View; label: string }[] = [
  { value: 'missions', label: 'Missions' },
  { value: 'week', label: 'This week' },
]

const number = (value: number, unit: string | null) =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}${unit ? ` ${unit}` : ''}`

/** The number's trend over the last 30 days, with its target as a dashed line. */
function Trend({ series, target }: { series: MissionNumber['series']; target: number | null }) {
  const values = series.map((p) => p.value)
  if (values.length < 2) return null
  const all = target !== null ? [...values, target] : values
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || 1
  const w = 96
  const h = 28
  const y = (v: number) => h - 2 - ((v - min) / span) * (h - 4)
  const line = values.map((v, i) => `${(i / (values.length - 1)) * w},${y(v)}`).join(' ')
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-7 w-24 shrink-0 overflow-visible text-primary"
      aria-label={`Last 30 days: ${values.join(', ')}`}
      role="img"
    >
      {target !== null && (
        <line
          x1={0}
          x2={w}
          y1={y(target)}
          y2={y(target)}
          className="stroke-muted-foreground/50"
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      )}
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function NumberBlock({ n }: { n: MissionNumber }) {
  const latest = n.series.at(-1)
  const first = n.series[0]
  const delta = latest && first && n.series.length > 1 ? latest.value - first.value : null
  return (
    <div className="flex shrink-0 items-center gap-3">
      <Trend series={n.series} target={n.target} />
      <div className="flex flex-col items-end text-right">
        <span className="text-lg leading-tight font-semibold tabular-nums">
          {latest ? number(latest.value, n.unit) : '—'}
        </span>
        <span className="text-xs text-muted-foreground">
          {n.label}
          {delta !== null && delta !== 0 && (
            <span className={delta > 0 ? 'text-success' : 'text-destructive-text'}>
              {' '}
              {delta > 0 ? '+' : ''}
              {number(delta, null)}
            </span>
          )}
          {n.target !== null && <> · target {number(n.target, n.unit)}</>}
        </span>
        {/* Whose word it is: Brigade's measurement, or the teammate's reading. */}
        <span className="text-[11px] text-muted-foreground/80">
          {n.source === 'goal' ? 'Measured by Brigade' : 'As the teammate read it'}
          {latest && <> · {timeAgo(latest.at)}</>}
        </span>
      </div>
    </div>
  )
}

const metricsText = (m: MissionOutput['metrics']) =>
  Object.entries(m)
    .map(([k, v]) => `${number(v, null)} ${k}`)
    .join(' · ')

function OutputLine({ output }: { output: MissionOutput }) {
  const metrics = metricsText(output.metrics)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">
        <span className="text-muted-foreground">{output.channel} · </span>
        {output.url ? (
          <a
            href={output.url}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
            title={output.summary}
          >
            {output.summary}
          </a>
        ) : (
          output.summary
        )}
        <span className="text-muted-foreground">
          {' '}
          · {timeAgo(output.at)}
          {metrics && <> · {metrics}</>}
        </span>
      </span>
      {output.url && <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
    </span>
  )
}

/** A draft to approve before its deadline: its text, Approve and Decline, from the ticket. */
function Approval({
  ticketId,
  title,
  draft,
  approveBy,
  threadId,
  onDone,
}: {
  ticketId: string
  title: string
  draft: string | null | undefined
  approveBy: string | null
  threadId: string | null
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const decide = async (approved: boolean) => {
    setPending(true)
    setError(undefined)
    try {
      await api(`/tickets/${ticketId}/resolve`, { body: { approved } })
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setPending(false)
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1 text-left"
        >
          <ChevronRight
            className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
            aria-hidden
          />
          <span className="truncate">
            Approve &ldquo;{title}&rdquo;
            {approveBy && (
              <span className="text-muted-foreground"> before {shortWakeTime(approveBy)}</span>
            )}
          </span>
        </button>
        <span className="ml-auto flex shrink-0 gap-1.5">
          <Button size="sm" disabled={pending} onClick={() => void decide(true)}>
            Approve
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void decide(false)}>
            Decline
          </Button>
        </span>
      </div>
      {open && draft && (
        <p className="ml-5 rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">
          {draft}
        </p>
      )}
      {open && threadId && (
        <Link
          href={`/app/threads/${threadId}`}
          className="ml-5 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Open its thread to ask for changes
        </Link>
      )}
      {error && <span className="ml-5 text-xs text-destructive-text">{error}</span>}
    </div>
  )
}

const KIND_ICON: Record<MissionAgendaItem['kind'], typeof CalendarClock> = {
  routine: CalendarClock,
  wakeup: AlarmClock,
  action: Send,
  approval: Stamp,
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3 text-sm">
      <span className="w-16 shrink-0 text-xs leading-5 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  )
}

const PLURAL: Record<MissionOutput['kind'], [string, string]> = {
  post: ['post', 'posts'],
  comment: ['comment', 'comments'],
  reply: ['reply', 'replies'],
  article: ['article', 'articles'],
  email: ['email', 'emails'],
  other: ['output', 'outputs'],
}

/** "3 replies, 1 post": what went out, by kind. */
function outputsText(byKind: MissionRow['week']['byKind']) {
  return (Object.entries(byKind) as [MissionOutput['kind'], number][])
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${PLURAL[kind][n === 1 ? 0 : 1]}`)
    .join(', ')
}

type State = 'needs' | 'moving' | 'quiet'

/** Where a mission stands, in a line: what waits on the member, else what went out this week. */
function stateOf(m: MissionRow): { state: State; text: string } {
  const approvals = m.needs.filter((n) => n.reason === 'approval')
  if (m.needs.length) {
    const text =
      m.needs.length > 1
        ? `${m.needs.length} things wait on you`
        : approvals.length
          ? `Approve “${approvals[0]!.title}”`
          : m.needs[0]!.title
    return { state: 'needs', text }
  }
  if (m.week.outputs)
    return { state: 'moving', text: `${outputsText(m.week.byKind)} out this week` }
  return { state: 'quiet', text: 'Nothing went out this week' }
}

const DOT: Record<State, string> = {
  needs: 'bg-warning',
  moving: 'bg-success',
  quiet: 'bg-muted-foreground/40',
}

/**
 * One mission as a status line: a dot (waits on you, moving, quiet), where it stands in a phrase,
 * its number. Its detail opens below it: drafts to approve, what is planned, what went out.
 */
function MissionLine({
  mission,
  onChanged,
  onEdit,
}: {
  mission: MissionRow
  onChanged: () => void
  onEdit: () => void
}) {
  const { me } = useDashboard()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  // A mission is its member's: they change it, an admin may archive it.
  const mine = mission.memberId === me.memberId
  const mayArchive = mine || me.role === 'owner' || me.role === 'admin'
  const archive = async () => {
    setError(undefined)
    try {
      await api(`/missions/${mission.id}`, { method: 'PATCH', body: { archived: true } })
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const { state, text } = stateOf(mission)
  const approvals = mission.needs.filter((n) => n.reason === 'approval' && n.ticketId)
  const needs = mission.needs.filter((n) => !(n.reason === 'approval' && n.ticketId))
  const next = mission.next
  const latest = mission.number?.series.at(-1)
  const running = mission.routines.filter((r) => !r.pausedAt).length
  return (
    <li className="border-t first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
      >
        <span className={cn('size-2 shrink-0 rounded-full', DOT[state])} aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{mission.title}</span>
          <span className="truncate text-sm text-muted-foreground">
            {mission.teammate.name} · {text}
            {next && (
              <>
                {' · next '}
                {shortWakeTime(next.at)}
              </>
            )}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className="font-semibold tabular-nums">
            {latest ? number(latest.value, mission.number!.unit) : mission.week.outputs}
          </span>
          <span className="text-xs text-muted-foreground">
            {latest ? mission.number!.label.toLowerCase() : 'this week'}
          </span>
        </span>
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div className="flex flex-col gap-3 px-4 pb-4 pl-9">
          <p className="text-sm text-muted-foreground">{mission.objective}</p>
          {(approvals.length > 0 || needs.length > 0) && (
            <Line label="Waits on you">
              {approvals.map((a) => (
                <Approval
                  key={a.ticketId}
                  ticketId={a.ticketId!}
                  title={a.title}
                  draft={a.draft}
                  approveBy={a.at ?? null}
                  threadId={a.threadId}
                  onDone={onChanged}
                />
              ))}
              {needs.map((n, i) =>
                n.threadId ? (
                  <Link
                    key={`${n.threadId}-${i}`}
                    href={`/app/threads/${n.threadId}`}
                    className="truncate hover:underline"
                  >
                    {n.title}
                  </Link>
                ) : (
                  <span key={i} className="truncate">
                    {n.title}
                  </span>
                ),
              )}
            </Line>
          )}
          {next && (
            <Line label="Next">
              <span className="flex min-w-0 gap-1.5">
                <span className="shrink-0 tabular-nums">{shortWakeTime(next.at)}</span>
                <span className="truncate text-muted-foreground">{next.title}</span>
              </span>
            </Line>
          )}
          <Line label="Went out">
            {mission.outputs.length ? (
              mission.outputs.map((o) => <OutputLine key={o.id} output={o} />)
            ) : (
              <span className="text-muted-foreground">Nothing recorded yet</span>
            )}
          </Line>
          {mission.number && mission.number.series.length > 1 && (
            <Line label={mission.number.label}>
              <NumberBlock n={mission.number} />
            </Line>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {mission.threads.map((t) => (
              <Link
                key={t.id}
                href={`/app/threads/${t.id}`}
                className="hover:text-foreground hover:underline"
              >
                {t.title}
              </Link>
            ))}
            {mission.routines.length > 0 && (
              <Link href="/app/routines" className="hover:text-foreground hover:underline">
                {running} {running === 1 ? 'routine' : 'routines'} running
              </Link>
            )}
            {mayArchive && (
              <span className="ml-auto flex gap-1">
                {mine && (
                  <Button size="sm" variant="ghost" onClick={onEdit}>
                    <Pencil aria-hidden /> Edit
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void archive()}
                  tooltip="Pauses its routines and cancels its plan"
                >
                  <Archive aria-hidden /> Archive
                </Button>
              </span>
            )}
          </div>
          {error && <span className="text-xs text-destructive-text">{error}</span>}
        </div>
      )}
    </li>
  )
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The start of the member's day, in their browser's timezone. */
function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function dayLabel(date: Date, today: Date) {
  const days = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - today.getTime()) /
      86_400_000,
  )
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()}`
}

const clock = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

function AgendaRow({
  item,
  mission,
  onChanged,
}: {
  item: MissionAgendaItem
  mission: string | undefined
  onChanged: () => void
}) {
  const Icon = KIND_ICON[item.kind]
  const past = new Date(item.at).getTime() < Date.now()
  const done =
    item.status === 'fired' ||
    item.status === 'declined' ||
    item.status === 'expired' ||
    (past && item.kind !== 'approval')
  const caption = [
    mission,
    item.teammate?.name,
    item.kind === 'action' && item.status === 'awaiting_approval' ? 'waits for approval' : null,
    item.status === 'declined' ? 'declined' : null,
    item.status === 'expired' ? 'not approved in time' : null,
  ].filter(Boolean)
  return (
    <li className="flex items-start gap-3 border-t px-4 py-3 first:border-t-0">
      <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">
        {clock(item.at)}
      </span>
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          item.kind === 'approval' ? 'text-warning' : 'text-muted-foreground',
        )}
        aria-hidden
      />
      <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', done && 'opacity-60')}>
        {item.kind === 'approval' && item.ticketId ? (
          <Approval
            ticketId={item.ticketId}
            title={item.title}
            draft={item.draft}
            approveBy={null}
            threadId={item.threadId}
            onDone={onChanged}
          />
        ) : item.threadId ? (
          <Link href={`/app/threads/${item.threadId}`} className="truncate hover:underline">
            {item.title}
          </Link>
        ) : (
          <span className="truncate">{item.title}</span>
        )}
        <span className="truncate text-xs text-muted-foreground">
          {item.kind === 'approval' ? 'Deadline to approve · ' : ''}
          {caption.join(' · ')}
        </span>
      </div>
    </li>
  )
}

function WeekView({ week, onChanged }: { week: MissionWeek; onChanged: () => void }) {
  const titles = new Map(week.missions.map((m) => [m.id, m.title]))
  const days = useMemo(() => {
    const today = startOfToday()
    const groups: { key: string; label: string; items: MissionAgendaItem[] }[] = []
    for (const item of week.items) {
      const date = new Date(item.at)
      const key = date.toDateString()
      const last = groups.at(-1)
      if (last?.key === key) last.items.push(item)
      else groups.push({ key, label: dayLabel(date, today), items: [item] })
    }
    return groups
  }, [week.items])
  if (!days.length)
    return (
      <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        Nothing planned this week. Routines, wake-ups and actions your teammates plan for their
        missions show here.
      </p>
    )
  return (
    <>
      {days.map((day) => (
        <section key={day.key} className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {day.label}
          </h2>
          <ul className="rounded-xl border bg-card">
            {day.items.map((item) => (
              <AgendaRow
                key={item.key}
                item={item}
                mission={titles.size > 1 ? titles.get(item.missionId) : undefined}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * A new mission, or changes to one: its words, its owner, the number it follows and its threads
 * (their sub-threads and routines come with them). A teammate also makes one from its thread.
 */
function MissionDialog({
  open,
  onOpenChange,
  mission,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Unset: a new mission. */
  mission?: MissionRow
  onSaved: () => void
}) {
  const { teammates, me } = useDashboard()
  const recent = useApi<ThreadSummary[]>(
    open ? '/threads?limit=100&sort=activity' : null,
    undefined,
    isList,
  )
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [teammateId, setTeammateId] = useState<string>()
  const [label, setLabel] = useState('')
  const [unit, setUnit] = useState('')
  const [target, setTarget] = useState('')
  const [threadIds, setThreadIds] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setTitle(mission?.title ?? '')
    setObjective(mission?.objective ?? '')
    setTeammateId(mission?.teammate.id)
    setLabel(mission?.metric?.label ?? '')
    setUnit(mission?.metric?.unit ?? '')
    setTarget(mission?.metric?.target != null ? String(mission.metric.target) : '')
    setThreadIds(mission?.threads.map((t) => t.id) ?? [])
    setSearch('')
    setError(undefined)
  }, [open, mission])

  const owner = teammateId ?? teammates[0]?.id
  // Its own threads first, then the latest active, as the search narrows them.
  const threads = useMemo(() => {
    const own = mission?.threads ?? []
    // Only threads they started: a mission is one member's.
    const rest = (recent.data ?? []).filter(
      (t) => t.startedBy.id === me.memberId && !own.some((o) => o.id === t.id),
    )
    const all = [...own.map((t) => ({ id: t.id, title: t.title })), ...rest]
    const q = search.trim().toLowerCase()
    return q ? all.filter((t) => t.title.toLowerCase().includes(q)) : all
  }, [recent.data, mission, search, me.memberId])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !owner) return
    const goal = target.trim() ? Number(target) : null
    if (goal !== null && !Number.isFinite(goal)) return setError('The target is a number')
    setBusy(true)
    setError(undefined)
    const metric = label.trim()
      ? { label: label.trim(), unit: unit.trim() || null, target: goal }
      : null
    try {
      const body = { title, objective, teammateId: owner, metric, threadIds }
      if (mission) await api(`/missions/${mission.id}`, { method: 'PATCH', body })
      else await api('/missions', { body })
      onOpenChange(false)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] grid-cols-1 overflow-y-auto sm:max-w-xl">
        <form onSubmit={(e) => void submit(e)} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{mission ? 'Edit mission' : 'New mission'}</DialogTitle>
            <DialogDescription>
              Ongoing work you delegate to a teammate. Its threads, their routines and what is
              planned there show here together.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="mission-title">
              <Input
                id="mission-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Grow LinkedIn"
                required
                maxLength={120}
                autoFocus
              />
            </Field>
            <Field label="Teammate" htmlFor="mission-teammate">
              <Select value={owner} onValueChange={setTeammateId}>
                <SelectTrigger id="mission-teammate" className="w-full">
                  <SelectValue placeholder="Choose a teammate" />
                </SelectTrigger>
                <SelectContent>
                  {teammates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <TeammateAvatar teammate={t} className="size-5" />
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Objective" htmlFor="mission-objective">
            <Textarea
              id="mission-objective"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="2,000 followers by January, with two posts a week"
              required
              maxLength={500}
              rows={2}
            />
          </Field>
          <Field
            label="Number to follow"
            hint="Optional. Your teammate records it where Brigade can't read it; a goal in one of its threads measures it instead."
          >
            <div className="grid grid-cols-[1fr_5rem_6rem] gap-2">
              <Input
                aria-label="Name"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Followers"
                maxLength={60}
              />
              <Input
                aria-label="Unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="Unit"
                maxLength={20}
                disabled={!label.trim()}
              />
              <Input
                aria-label="Target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="Target"
                inputMode="decimal"
                disabled={!label.trim()}
              />
            </div>
          </Field>
          <Field
            label="Threads"
            hint="Threads you started. Their sub-threads and routines come with them."
          >
            <Input
              aria-label="Search threads"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search threads"
            />
            <ul className="max-h-56 overflow-y-auto rounded-lg border">
              {!recent.data && !mission?.threads.length ? (
                <li className="px-3 py-2">
                  <Skeleton className="h-5 w-full" />
                </li>
              ) : threads.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">No threads</li>
              ) : (
                threads.map((t) => {
                  const checked = threadIds.includes(t.id)
                  return (
                    <li key={t.id} className="border-t first:border-t-0">
                      <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(on) =>
                            setThreadIds((ids) =>
                              on ? [...ids, t.id] : ids.filter((id) => id !== t.id),
                            )
                          }
                        />
                        <span className="truncate">{t.title}</span>
                      </label>
                    </li>
                  )
                })
              )}
            </ul>
          </Field>
          {error && <p className="text-sm text-destructive-text">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !owner}>
              {mission ? 'Save' : 'Create mission'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The Missions page. */
export function MissionsPage() {
  const [view, setView] = useState<View>('missions')
  const from = useMemo(() => startOfToday().toISOString(), [])
  const missions = useApi<{ missions: MissionRow[] }>('/missions', LIVE)
  const week = useApi<MissionWeek>(`/missions/week?from=${encodeURIComponent(from)}`, LIVE)
  const reload = () => {
    void missions.reload()
    void week.reload()
  }
  const list = missions.data?.missions ?? []
  const error = missions.error ?? week.error
  const [editing, setEditing] = useState<MissionRow | 'new' | null>(null)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight">Missions</h1>
          <p className="max-w-prose text-muted-foreground">
            Ongoing work you delegated: where each mission stands, what comes next and what waits on
            you, without opening its threads.
          </p>
        </div>
        <Button className="ml-auto" onClick={() => setEditing('new')}>
          <Plus aria-hidden />
          New mission
        </Button>
      </header>

      {list.length > 0 && (
        <div
          role="radiogroup"
          aria-label="Missions view"
          className="-mb-2 flex w-fit gap-0.5 rounded-full bg-secondary p-[3px]"
        >
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="radio"
              aria-checked={view === v.value}
              onClick={() => setView(v.value)}
              className={cn(
                'flex h-7 items-center rounded-full px-3 text-[13px] font-medium text-muted-foreground',
                view === v.value && 'bg-card font-semibold text-foreground shadow-xs',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}

      {!missions.data ? (
        <Skeleton className="h-32 w-full" />
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No missions yet. A mission gathers the threads and routines of ongoing work a teammate
          owns, such as growing an account, with its plan and what went out. Make one here, or ask
          the teammate in its thread.
        </p>
      ) : view === 'week' ? (
        week.data ? (
          <WeekView week={week.data} onChanged={reload} />
        ) : (
          <Skeleton className="h-32 w-full" />
        )
      ) : (
        <ul className="rounded-xl border bg-card">
          {list.map((m) => (
            <MissionLine key={m.id} mission={m} onChanged={reload} onEdit={() => setEditing(m)} />
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-destructive-text">{error.message}</p>}
      <MissionDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        mission={editing && editing !== 'new' ? editing : undefined}
        onSaved={reload}
      />
    </div>
  )
}
