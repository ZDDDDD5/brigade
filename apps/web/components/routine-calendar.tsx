'use client'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  History,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  RotateCw,
} from 'lucide-react'
import Link from 'next/link'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { isAdmin, TeammateAvatar, useDashboard } from '@/components/dashboard'
import { describeCron, localTimezone, OUTCOME, zoneName } from '@/components/schedules'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, type Schedule } from '@/lib/api'
import {
  addDays,
  dayIndex,
  hoursShown,
  minuteOfDay,
  missedRuns,
  movableOf,
  movedCron,
  runsBetween,
  slotCron,
  stackOut,
  weekStart,
} from '@/lib/routine-calendar'
import { cn } from '@/lib/utils'

/** Pixels an hour takes. */
const HOUR = 56
/** Pixels a run's row takes; runs closer than this stack in one card. */
const ROW = 22
const ROW_MINUTES = (ROW * 60) / HOUR
/** Minutes a drag moves a routine by. */
const SNAP = 15
const DAYS = 7
/** Tooltips over runs show almost at once: the grid is read by pointing. */
const TIP_DELAY = 120

type Run = Schedule['recentRuns'][number]

/** A run on the calendar: one that ran, one its cron plans, or one that could not start. */
type Block = {
  key: string
  schedule: Schedule
  at: Date
  day: number
  minute: number
  kind: 'run' | 'planned' | 'missed'
  run?: Run
}

type Drag = {
  key: string
  schedule: Schedule
  at: Date
  day: number
  minute: number
  x: number
  y: number
  columnWidth: number
  moved: boolean
  /** Minutes and days the routine moves by. */
  minutes: number
  days: number
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
/** Minutes since midnight as 09:30. */
const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const zoneOf = (s: Schedule) => (s.timezone !== localTimezone() ? ` (${zoneName(s.timezone)})` : '')
const column = (day: number) => ({
  left: `calc(${day} * 100% / ${DAYS} + 2px)`,
  width: `calc(100% / ${DAYS} - 4px)`,
})

/**
 * Routines as a week: each run at its time, those that ran with how they ended, those that could
 * not start dashed. Only the hours around them show; the rest fold away. Dragging a routine you
 * own moves all its runs (its cron); clicking an empty slot starts a new one there.
 */
export function RoutineCalendar({
  schedules,
  toolbar,
  onEdit,
  onNew,
  onChanged,
}: {
  schedules: Schedule[]
  /** Shown first in the calendar's own bar, e.g. the page's view switch. */
  toolbar?: React.ReactNode
  onEdit: (schedule: Schedule) => void
  /** A new routine, weekly at the slot clicked. */
  onNew: (cron: string) => void
  onChanged: () => void
}) {
  const { me } = useDashboard()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const [start, setStart] = useState(() => weekStart(new Date()))
  const end = useMemo(() => addDays(start, DAYS), [start])
  // Crons a drag saved, shown until the list comes back with them.
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [drag, setDrag] = useState<Drag | null>(null)
  // The drag as the pointer left it, read between renders; state only once the pointer moved,
  // so a plain click opens the menu in one render.
  const dragging = useRef<Drag | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [allHours, setAllHours] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean; undo?: () => void }>()
  const days = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSaved((all) => {
      const waiting = Object.entries(all).filter(
        ([id, cron]) => schedules.find((s) => s.id === id)?.cron !== cron,
      )
      return waiting.length === Object.keys(all).length ? all : Object.fromEntries(waiting)
    })
  }, [schedules])

  const today = dayIndex(now, start)
  const thisWeek = today >= 0 && today < DAYS

  const { blocks, often, paused } = useMemo(() => {
    const blocks: Block[] = []
    const often: Schedule[] = []
    const add = (schedule: Schedule, at: Date, key: string, kind: Block['kind'], run?: Run) =>
      blocks.push({
        key,
        schedule,
        at,
        day: dayIndex(at, start),
        minute: minuteOfDay(at),
        kind,
        run,
      })
    const until = new Date(Math.min(end.getTime(), now.getTime() - 60_000))
    for (const s of [...schedules].sort((a, b) => a.title.localeCompare(b.title))) {
      const cron = saved[s.id] ?? s.cron
      const { runs, frequent } = runsBetween(cron, s.timezone, start, end)
      if (frequent) {
        if (!s.pausedAt) often.push(s)
        continue
      }
      for (const run of s.recentRuns) {
        const at = new Date(run.createdAt)
        if (at >= start && at < end) add(s, at, `run-${run.id}`, 'run', run)
      }
      for (const at of missedRuns(s, start, until))
        add(s, at, `missed-${s.id}-${at.getTime()}`, 'missed')
      if (s.pausedAt) continue
      for (const at of runs) if (at > now) add(s, at, `${s.id}-${at.getTime()}`, 'planned')
    }
    return { blocks, often, paused: schedules.filter((s) => s.pausedAt).length }
  }, [schedules, saved, start, end, now])

  // The hours shown follow the runs where they are, not where a drag moves them.
  const fitted = hoursShown([
    ...blocks.map((b) => b.minute),
    ...(thisWeek ? [minuteOfDay(now)] : []),
  ])
  const { from, to } = allHours ? { from: 0, to: 24 } : fitted
  const folds = fitted.from > 0 || fitted.to < 24
  const y = (minute: number) => ((minute - from * 60) * HOUR) / 60

  const owns = (s: Schedule) => s.ownerMemberId === me.memberId
  const manages = (s: Schedule) => owns(s) || isAdmin(me)
  const movable = (s: Schedule) => owns(s) && movableOf(saved[s.id] ?? s.cron) !== null
  const moving = (b: Block) =>
    drag?.moved && b.kind === 'planned' && b.schedule.id === drag.schedule.id

  // Each day's runs in cards; while a routine is dragged, its runs stay put (faded) and copies
  // follow the pointer, so the row holding the pointer is never taken out of the page.
  const cards = Array.from({ length: DAYS }, (_, day) =>
    stackOut(
      blocks.filter((b) => b.day === day && b.minute >= from * 60 && b.minute < to * 60),
      ROW_MINUTES,
    ).map((card) => ({ ...card, day })),
  ).flat()
  const ghosts = drag?.moved
    ? blocks
        .filter(moving)
        .map((b) => ({ ...b, day: b.day + drag.days, minute: b.minute + drag.minutes }))
        .filter((b) => b.day >= 0 && b.day < DAYS)
    : []

  async function act(s: Schedule, path: string) {
    setNote(undefined)
    try {
      await api(`/schedules/${s.id}${path}`, { method: 'POST', body: {} })
      if (path === '/run') setNote({ text: `${s.title} started` })
      onChanged()
    } catch (e) {
      setNote({ text: (e as Error).message, error: true })
    }
  }

  /** Saves a routine's new cron; `before` is what Undo puts back. */
  async function write(s: Schedule, cron: string, before: string, undoable = true) {
    setSaved((all) => ({ ...all, [s.id]: cron }))
    setNote(undefined)
    try {
      await api(`/schedules/${s.id}`, { method: 'PATCH', body: { cron, timezone: s.timezone } })
      setNote({
        text: `${s.title} now runs ${describeCron(cron).replace(/^At/, 'at')}${zoneOf(s)}`,
        undo: undoable ? () => void write(s, before, cron, false) : undefined,
      })
      onChanged()
    } catch (e) {
      setSaved(({ [s.id]: _, ...rest }) => rest)
      setNote({ text: (e as Error).message, error: true })
    }
  }

  function drop(d: Drag) {
    const s = d.schedule
    const before = saved[s.id] ?? s.cron
    const rhythm = movableOf(before)
    if (!rhythm || (!d.minutes && !d.days)) return
    const at = new Date(addDays(d.at, d.days).getTime() + d.minutes * 60_000)
    const cron = movedCron(rhythm, at, s.timezone)
    if (cron !== before) void write(s, cron, before)
  }

  function newAt(e: React.MouseEvent<HTMLDivElement>) {
    // Only a click on the grid itself: one in a run's menu bubbles here through React too.
    if (e.target !== e.currentTarget) return
    const box = e.currentTarget.getBoundingClientRect()
    const day = clamp(Math.floor(((e.clientX - box.left) / box.width) * DAYS), 0, DAYS - 1)
    const minute = clamp(
      from * 60 + Math.floor((e.clientY - box.top) / (HOUR / 2)) * 30,
      0,
      23 * 60 + 30,
    )
    const at = addDays(start, day)
    at.setHours(Math.floor(minute / 60), minute % 60)
    onNew(slotCron(at))
  }

  const range = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatRange(start, addDays(start, DAYS - 1))

  /** What a run is, in its tooltip and at the top of its menu. */
  const about = (b: Pick<Block, 'schedule' | 'kind' | 'run' | 'minute'>) => {
    const s = b.schedule
    return (
      <>
        <span className="block truncate font-semibold">{s.title}</span>
        <span className="block text-xs text-muted-foreground">
          {b.kind === 'run' && b.run
            ? `${OUTCOME[b.run.outcome].label} · ${hhmm(b.minute)}`
            : `${describeCron(saved[s.id] ?? s.cron)}${zoneOf(s)}`}
        </span>
        {b.kind === 'missed' && (
          <span className="block text-xs text-destructive-text">
            Couldn&apos;t start at {hhmm(b.minute)}: {s.lastError}
          </span>
        )}
        <span className="block truncate text-xs text-muted-foreground">
          {s.teammate.name}
          {!owns(s) && ` · on ${s.owner.user.name}'s accounts`}
        </span>
      </>
    )
  }

  const menuFor = (b: Pick<Block, 'schedule' | 'kind' | 'run' | 'minute'>) => {
    const s = b.schedule
    const active = !s.pausedAt
    return (
      <DropdownMenuContent align="start" className="w-64">
        <div className="px-2 py-1.5 text-sm">{about(b)}</div>
        <DropdownMenuSeparator />
        {b.run && (
          <DropdownMenuItem asChild>
            <Link href={`/app/threads/${b.run.id}`}>
              <History aria-hidden />
              Open this run
            </Link>
          </DropdownMenuItem>
        )}
        {manages(s) && (
          <>
            <DropdownMenuItem onSelect={() => void act(s, '/run')}>
              <Play aria-hidden />
              Run now
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void act(s, active ? '/pause' : '/resume')}>
              {active ? <Pause aria-hidden /> : <RotateCw aria-hidden />}
              {active ? 'Pause' : 'Resume'}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem disabled={!owns(s)} onSelect={() => onEdit(s)}>
          <Pencil aria-hidden />
          Edit
        </DropdownMenuItem>
        {s.parentSession && (
          <DropdownMenuItem asChild>
            <Link href={`/app/threads/${s.parentSession.id}`}>
              <MessageSquare aria-hidden />
              <span className="truncate">Reports in “{s.parentSession.title}”</span>
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    )
  }

  const pointer = {
    down(b: Block, e: React.PointerEvent<HTMLButtonElement>) {
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      dragging.current = {
        key: b.key,
        schedule: b.schedule,
        at: b.at,
        day: b.day,
        minute: b.minute,
        x: e.clientX,
        y: e.clientY,
        columnWidth: (days.current?.clientWidth ?? 700) / DAYS,
        moved: false,
        minutes: 0,
        days: 0,
      }
    },
    move(b: Block, e: React.PointerEvent<HTMLButtonElement>) {
      const d = dragging.current
      if (d?.key !== b.key) return
      const dx = e.clientX - d.x
      const dy = e.clientY - d.y
      if (!d.moved && Math.abs(dx) + Math.abs(dy) <= 4) return
      const s = b.schedule
      const weekly = movableOf(saved[s.id] ?? s.cron)?.kind === 'weekly'
      const next = {
        ...d,
        moved: true,
        minutes: clamp(
          Math.round(dy / ((HOUR * SNAP) / 60)) * SNAP,
          from * 60 - d.minute,
          to * 60 - SNAP - d.minute,
        ),
        days: weekly ? clamp(Math.round(dx / d.columnWidth), -d.day, DAYS - 1 - d.day) : 0,
      }
      dragging.current = next
      if (!d.moved || next.minutes !== d.minutes || next.days !== d.days) setDrag(next)
    },
    up(b: Block) {
      const d = dragging.current
      if (d?.key !== b.key) return
      dragging.current = null
      if (d.moved) {
        setDrag(null)
        drop(d)
      } else setMenu(b.key)
    },
    cancel() {
      dragging.current = null
      setDrag(null)
    },
    open(key: string, next: boolean) {
      setMenu(next ? key : null)
    },
    menu: menuFor,
    about,
  }
  // Rows get stable handlers that call this render's, so a click re-renders only the rows it changes.
  const live = useRef(pointer)
  live.current = pointer
  const on = useMemo<RowHandlers>(
    () => ({
      down: (b, e) => live.current.down(b, e),
      move: (b, e) => live.current.move(b, e),
      up: (b) => live.current.up(b),
      cancel: () => live.current.cancel(),
      open: (key, next) => live.current.open(key, next),
      menu: (b) => live.current.menu(b),
      about: (b) => live.current.about(b),
    }),
    [],
  )
  const open = (key: string) => (next: boolean) => setMenu(next ? key : null)

  const fold = (label: string, up: boolean) => (
    <button
      type="button"
      onClick={() => setAllHours(true)}
      className="grid w-full grid-cols-[48px_minmax(0,1fr)] items-center border-b bg-secondary/40 py-1 text-left text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      <span className="flex justify-end pr-2">
        {up ? (
          <ChevronUp className="size-3.5" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5" aria-hidden />
        )}
      </span>
      <span>{label} · no routines</span>
    </button>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <Button variant="outline" size="sm" onClick={() => setStart(weekStart(new Date()))}>
          Today
        </Button>
        <div className="flex">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Previous week"
            onClick={() => setStart(addDays(start, -DAYS))}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Next week"
            onClick={() => setStart(addDays(start, DAYS))}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
        <span className="font-semibold">{range}</span>
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {allHours && folds && (
            <button
              type="button"
              onClick={() => setAllHours(false)}
              className="hover:text-foreground hover:underline"
            >
              Hide empty hours
            </button>
          )}
          {zoneName(localTimezone())} time
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="grid grid-cols-[48px_repeat(7,minmax(0,1fr))] border-b">
              <span />
              {Array.from({ length: DAYS }, (_, day) => {
                const date = addDays(start, day)
                return (
                  <span
                    key={day}
                    className={cn(
                      'py-2 text-center text-xs text-muted-foreground',
                      day === today && 'bg-primary/[0.04] font-semibold text-primary',
                    )}
                  >
                    {new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(date)}{' '}
                    {date.getDate()}
                  </span>
                )
              })}
            </div>

            {often.length > 0 && (
              <div className="grid grid-cols-[48px_minmax(0,1fr)] items-center border-b py-1.5">
                <span className="pr-2 text-right text-[11px] text-muted-foreground">Often</span>
                <div className="flex min-w-0 flex-wrap gap-1 pr-2">
                  {often.map((s) => (
                    <DropdownMenu
                      key={s.id}
                      open={menu === `often-${s.id}`}
                      onOpenChange={open(`often-${s.id}`)}
                    >
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="flex max-w-full min-w-0 items-center gap-1.5 rounded-[6px] bg-primary/10 px-1.5 py-0.5 text-left text-xs hover:bg-primary/15"
                        >
                          <TeammateAvatar teammate={s.teammate} className="size-3.5 shrink-0" />
                          <span className="truncate font-semibold">{s.title}</span>
                          <span className="truncate text-muted-foreground">
                            {describeCron(s.cron)}
                            {zoneOf(s)}
                          </span>
                        </button>
                      </DropdownMenuTrigger>
                      {menuFor({ schedule: s, kind: 'planned', minute: 0 })}
                    </DropdownMenu>
                  ))}
                </div>
              </div>
            )}

            {from > 0 && fold(`00:00 – ${hhmm(from * 60)}`, true)}

            <div
              className="grid grid-cols-[48px_minmax(0,1fr)]"
              style={{ height: (to - from) * HOUR }}
            >
              <div className="relative">
                {Array.from({ length: to - from - 1 }, (_, i) => (
                  <span
                    key={i}
                    className="absolute right-2 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
                    style={{ top: (i + 1) * HOUR }}
                  >
                    {hhmm((from + i + 1) * 60)}
                  </span>
                ))}
              </div>
              <div
                ref={days}
                role="presentation"
                onClick={newAt}
                className="relative cursor-cell border-l"
                style={{
                  backgroundImage: 'linear-gradient(var(--border) 1px, transparent 1px)',
                  backgroundSize: `100% ${HOUR}px`,
                }}
              >
                {thisWeek && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 bg-primary/[0.04]"
                    style={{
                      left: `calc(${today} * 100% / ${DAYS})`,
                      width: `calc(100% / ${DAYS})`,
                    }}
                  />
                )}
                {Array.from({ length: DAYS - 1 }, (_, i) => (
                  <span
                    key={i}
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 w-px bg-border"
                    style={{ left: `calc(${i + 1} * 100% / ${DAYS})` }}
                  />
                ))}
                {thisWeek && minuteOfDay(now) >= from * 60 && minuteOfDay(now) < to * 60 && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute z-20 h-0.5 bg-primary before:absolute before:-top-[3px] before:-left-1 before:size-2 before:rounded-full before:bg-primary"
                    style={{
                      left: `calc(${today} * 100% / ${DAYS})`,
                      width: `calc(100% / ${DAYS})`,
                      top: y(minuteOfDay(now)),
                    }}
                  />
                )}
                {cards.map((card) => {
                  const timed = new Set(card.items.map((b) => b.minute)).size > 1
                  return (
                    <div
                      key={card.items[0]!.key}
                      className="absolute z-10 flex flex-col gap-0.5"
                      style={{ ...column(card.day), top: y(card.minute) + 1 }}
                    >
                      {card.items.map((b) => (
                        <Row
                          key={b.key}
                          block={b}
                          timed={timed}
                          open={menu === b.key}
                          canMove={b.kind === 'planned' && movable(b.schedule)}
                          faded={Boolean(moving(b))}
                          quiet={drag !== null}
                          on={on}
                        />
                      ))}
                    </div>
                  )
                })}
                {ghosts.map((b) => (
                  <div
                    key={`ghost-${b.key}`}
                    aria-hidden
                    className="pointer-events-none absolute z-30 flex items-center gap-1 overflow-hidden rounded-[6px] bg-primary/25 px-1 text-xs shadow-md"
                    style={{ ...column(b.day), top: y(b.minute) + 1, height: ROW - 2 }}
                  >
                    <TeammateAvatar teammate={b.schedule.teammate} className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      {b.schedule.title}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                      {hhmm(b.minute)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {to < 24 && fold(`${hhmm(to * 60)} – 24:00`, false)}
          </div>
        </div>
      </div>

      <p
        aria-live="polite"
        className={cn(
          'min-h-5 text-sm text-muted-foreground',
          note?.error && 'text-destructive-text',
        )}
      >
        {note ? (
          <>
            {note.text}
            {note.undo && (
              <button
                type="button"
                onClick={note.undo}
                className="ml-2 font-semibold text-primary hover:underline"
              >
                Undo
              </button>
            )}
          </>
        ) : (
          <>
            Drag a routine to move all its runs, or click an empty slot to add one.
            {paused > 0 &&
              ` ${paused} paused ${paused === 1 ? 'routine isn’t' : 'routines aren’t'} shown.`}
          </>
        )}
      </p>
    </div>
  )
}

type RowHandlers = {
  down: (b: Block, e: React.PointerEvent<HTMLButtonElement>) => void
  move: (b: Block, e: React.PointerEvent<HTMLButtonElement>) => void
  up: (b: Block) => void
  cancel: () => void
  open: (key: string, open: boolean) => void
  menu: (b: Block) => React.ReactNode
  about: (b: Block) => React.ReactNode
}

/**
 * One run's row in a card: who does it and what; the time when its card holds several. Memoized:
 * opening one run's menu re-renders that row, not the week.
 */
const Row = memo(function Row({
  block: b,
  timed,
  open,
  canMove,
  faded,
  quiet,
  on,
}: {
  block: Block
  timed: boolean
  open: boolean
  canMove: boolean
  /** Its routine is being dragged: a copy follows the pointer. */
  faded: boolean
  /** No tooltip while something is dragged. */
  quiet: boolean
  on: RowHandlers
}) {
  const s = b.schedule
  return (
    <DropdownMenu open={open} onOpenChange={(next) => on.open(b.key, next)}>
      <Tooltip delayDuration={TIP_DELAY}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${s.title}, ${hhmm(b.minute)}`}
            onClick={(e) => {
              e.stopPropagation()
              if (!canMove) on.open(b.key, true)
            }}
            onKeyDown={(e) => {
              if (canMove && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                on.open(b.key, true)
              }
            }}
            onPointerDown={canMove ? (e) => on.down(b, e) : undefined}
            onPointerMove={canMove ? (e) => on.move(b, e) : undefined}
            onPointerUp={canMove ? () => on.up(b) : undefined}
            onPointerCancel={canMove ? () => on.cancel() : undefined}
            className={cn(
              'relative flex w-full items-center gap-1 overflow-hidden rounded-[6px] px-1 text-left text-xs select-none',
              b.kind === 'planned' && 'bg-primary/10 hover:bg-primary/15',
              b.kind === 'run' && 'bg-secondary text-muted-foreground hover:bg-secondary/80',
              b.kind === 'missed' &&
                'border border-dashed border-warning text-muted-foreground hover:bg-warning/10',
              canMove && 'cursor-grab touch-none',
              faded && 'opacity-40',
            )}
            style={{ height: ROW - 2 }}
          >
            <TeammateAvatar teammate={s.teammate} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-semibold">{s.title}</span>
            {timed && (
              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                {hhmm(b.minute)}
              </span>
            )}
            {b.run && (
              <span
                aria-label={OUTCOME[b.run.outcome].label}
                className={cn('size-1.5 shrink-0 rounded-full', OUTCOME[b.run.outcome].dot)}
              />
            )}
            <DropdownMenuTrigger asChild>
              <span aria-hidden className="pointer-events-none absolute inset-0" />
            </DropdownMenuTrigger>
          </button>
        </TooltipTrigger>
        {!quiet && !open && (
          <TooltipContent side="right" align="start" className="flex max-w-64 flex-col gap-0.5">
            {on.about(b)}
            {canMove && (
              <span className="text-xs text-muted-foreground">Drag to move all its runs</span>
            )}
          </TooltipContent>
        )}
      </Tooltip>
      {open && on.menu(b)}
    </DropdownMenu>
  )
})
