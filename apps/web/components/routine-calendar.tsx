'use client'
import {
  ChevronLeft,
  ChevronRight,
  History,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  RotateCw,
} from 'lucide-react'
import Link from 'next/link'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isAdmin, useDashboard } from '@/components/dashboard'
import { describeCron, localTimezone, OUTCOME, zoneName } from '@/components/schedules'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { api, type Schedule } from '@/lib/api'
import {
  addDays,
  dayIndex,
  laneOut,
  minuteOfDay,
  movableOf,
  movedCron,
  runsBetween,
  slotCron,
  weekStart,
} from '@/lib/routine-calendar'
import { cn } from '@/lib/utils'

/** Pixels an hour takes. */
const HOUR = 56
/** Minutes a drag moves a routine by. */
const SNAP = 15
/** Minutes a block covers: blocks closer than this sit side by side. */
const SPAN = 30
const DAYS = 7

type Run = Schedule['recentRuns'][number]

/** A run on the calendar: a past one (`run`), or one its cron plans. */
type Block = { key: string; schedule: Schedule; at: Date; day: number; minute: number; run?: Run }

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
const clock = (date: Date) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date)
/** Minutes since midnight as 09:30. */
const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const zoneOf = (s: Schedule) => (s.timezone !== localTimezone() ? ` (${zoneName(s.timezone)})` : '')

/** Where a block sits in the days' area. */
const place = (day: number, minute: number, lane = 0, lanes = 1) => ({
  left: `calc(${day} * 100% / ${DAYS} + ${lane} * 100% / ${DAYS * lanes} + 2px)`,
  width: `calc(100% / ${DAYS * lanes} - 4px)`,
  top: (minute * HOUR) / 60 + 1,
  height: (SPAN * HOUR) / 60 - 2,
})

/**
 * Routines as a week: each run at its time, past ones with how they ended. Dragging a routine
 * you own moves all its runs (its cron); clicking an empty slot starts a new one there.
 */
export function RoutineCalendar({
  schedules,
  onEdit,
  onNew,
  onChanged,
}: {
  schedules: Schedule[]
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
  const end = addDays(start, DAYS)
  // Crons a drag saved, shown until the list comes back with them.
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [drag, setDrag] = useState<Drag | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; error?: boolean; undo?: () => void }>()
  const scroller = useRef<HTMLDivElement>(null)
  const days = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSaved((all) => {
      const waiting = Object.entries(all).filter(
        ([id, cron]) => schedules.find((s) => s.id === id)?.cron !== cron,
      )
      return waiting.length === Object.keys(all).length ? all : Object.fromEntries(waiting)
    })
  }, [schedules])

  const { blocks, often, paused } = useMemo(() => {
    const blocks: Block[] = []
    const often: Schedule[] = []
    const block = (schedule: Schedule, at: Date, key: string, run?: Run) =>
      blocks.push({ key, schedule, at, day: dayIndex(at, start), minute: minuteOfDay(at), run })
    for (const s of schedules) {
      const cron = saved[s.id] ?? s.cron
      const { runs, frequent } = runsBetween(cron, s.timezone, start, end)
      if (frequent) {
        if (!s.pausedAt) often.push(s)
        continue
      }
      for (const run of s.recentRuns) {
        const at = new Date(run.createdAt)
        if (at >= start && at < end) block(s, at, `run-${run.id}`, run)
      }
      if (s.pausedAt) continue
      for (const at of runs) if (at > now) block(s, at, `${s.id}-${at.getTime()}`)
    }
    return { blocks, often, paused: schedules.filter((s) => s.pausedAt).length }
  }, [schedules, saved, start, end, now])

  // Open on the morning, or earlier when a routine runs before it.
  const first = Math.min(7 * 60, ...blocks.map((b) => b.minute))
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, ((first - 30) * HOUR) / 60)
    // Only when the week changes, not as runs move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start])

  const shown = blocks
    .map((b) =>
      drag?.moved && !b.run && b.schedule.id === drag.schedule.id
        ? { ...b, day: b.day + drag.days, minute: b.minute + drag.minutes }
        : b,
    )
    .filter((b) => b.day >= 0 && b.day < DAYS && b.minute >= 0 && b.minute < 24 * 60)
  const placed = Array.from({ length: DAYS }, (_, day) =>
    laneOut(
      shown.filter((b) => b.day === day),
      SPAN,
    ),
  ).flat()

  const owns = (s: Schedule) => s.ownerMemberId === me.memberId
  const manages = (s: Schedule) => owns(s) || isAdmin(me)
  const movable = (s: Schedule) => owns(s) && movableOf(saved[s.id] ?? s.cron) !== null

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
    const to = new Date(addDays(d.at, d.days).getTime() + d.minutes * 60_000)
    const cron = movedCron(rhythm, to, s.timezone)
    if (cron !== before) void write(s, cron, before)
  }

  function newAt(e: React.MouseEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect()
    const day = clamp(Math.floor(((e.clientX - box.left) / box.width) * DAYS), 0, DAYS - 1)
    const minute = clamp(Math.floor((e.clientY - box.top) / (HOUR / 2)) * 30, 0, 23 * 60 + 30)
    const at = addDays(start, day)
    at.setHours(Math.floor(minute / 60), minute % 60)
    onNew(slotCron(at))
  }

  const today = dayIndex(now, start)
  const range = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatRange(start, addDays(start, DAYS - 1))

  const menuFor = (b: Pick<Block, 'key' | 'schedule' | 'run'>) => {
    const s = b.schedule
    const active = !s.pausedAt
    return (
      <DropdownMenuContent align="start" className="w-56">
        <div className="flex flex-col gap-0.5 px-2 py-1.5">
          <span className="truncate text-sm font-semibold">{s.title}</span>
          <span className="text-xs text-muted-foreground">
            {b.run
              ? `${OUTCOME[b.run.outcome].label} · ${clock(new Date(b.run.createdAt))}`
              : `${describeCron(saved[s.id] ?? s.cron)}${zoneOf(s)}`}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {s.teammate.name}
            {!owns(s) && ` · on ${s.owner.user.name}'s accounts`}
          </span>
        </div>
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

  const open = (key: string) => (next: boolean) => setMenu(next ? key : null)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
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
        <span className="ml-auto text-xs text-muted-foreground">
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
                      day === today && 'font-semibold text-primary',
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
                          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-left text-xs hover:bg-primary/15"
                        >
                          <span className="truncate font-semibold">{s.title}</span>
                          <span className="truncate text-muted-foreground">
                            {describeCron(s.cron)}
                            {zoneOf(s)}
                          </span>
                        </button>
                      </DropdownMenuTrigger>
                      {menuFor({ key: `often-${s.id}`, schedule: s })}
                    </DropdownMenu>
                  ))}
                </div>
              </div>
            )}

            <div ref={scroller} className="h-[min(65dvh,640px)] overflow-y-auto">
              <div className="grid grid-cols-[48px_minmax(0,1fr)]" style={{ height: 24 * HOUR }}>
                <div className="relative">
                  {Array.from({ length: 23 }, (_, i) => (
                    <span
                      key={i}
                      className="absolute right-2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground"
                      style={{ top: (i + 1) * HOUR }}
                    >
                      {String(i + 1).padStart(2, '0')}:00
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
                  {Array.from({ length: DAYS - 1 }, (_, i) => (
                    <span
                      key={i}
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 w-px bg-border"
                      style={{ left: `calc(${i + 1} * 100% / ${DAYS})` }}
                    />
                  ))}
                  {today >= 0 && today < DAYS && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute z-20 h-0.5 bg-primary before:absolute before:-top-[3px] before:-left-1 before:size-2 before:rounded-full before:bg-primary"
                      style={{
                        left: `calc(${today} * 100% / ${DAYS})`,
                        width: `calc(100% / ${DAYS})`,
                        top: (minuteOfDay(now) * HOUR) / 60,
                      }}
                    />
                  )}
                  {placed.map((b) => {
                    const s = b.schedule
                    const canMove = !b.run && movable(s)
                    const dragging = drag?.moved && drag.schedule.id === s.id && !b.run
                    return (
                      <DropdownMenu key={b.key} open={menu === b.key} onOpenChange={open(b.key)}>
                        <button
                          type="button"
                          title={
                            canMove
                              ? `${s.title} · drag to move all its runs`
                              : `${s.title}${b.run ? ` · ${OUTCOME[b.run.outcome].label}` : ''}`
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            if (!canMove) setMenu(b.key)
                          }}
                          onKeyDown={(e) => {
                            if (canMove && (e.key === 'Enter' || e.key === ' ')) {
                              e.preventDefault()
                              setMenu(b.key)
                            }
                          }}
                          onPointerDown={(e) => {
                            if (!canMove || e.button !== 0) return
                            e.currentTarget.setPointerCapture(e.pointerId)
                            setDrag({
                              key: b.key,
                              schedule: s,
                              at: b.at,
                              day: b.day,
                              minute: b.minute,
                              x: e.clientX,
                              y: e.clientY,
                              columnWidth: (days.current?.clientWidth ?? 700) / DAYS,
                              moved: false,
                              minutes: 0,
                              days: 0,
                            })
                          }}
                          onPointerMove={(e) => {
                            if (drag?.key !== b.key) return
                            const dx = e.clientX - drag.x
                            const dy = e.clientY - drag.y
                            const moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 4
                            if (!moved) return
                            const weekly = movableOf(saved[s.id] ?? s.cron)?.kind === 'weekly'
                            setDrag({
                              ...drag,
                              moved,
                              minutes: clamp(
                                Math.round(dy / ((HOUR * SNAP) / 60)) * SNAP,
                                -drag.minute,
                                24 * 60 - SNAP - drag.minute,
                              ),
                              days: weekly
                                ? clamp(
                                    Math.round(dx / drag.columnWidth),
                                    -drag.day,
                                    DAYS - 1 - drag.day,
                                  )
                                : 0,
                            })
                          }}
                          onPointerUp={() => {
                            if (drag?.key !== b.key) return
                            setDrag(null)
                            if (drag.moved) drop(drag)
                            else setMenu(b.key)
                          }}
                          onPointerCancel={() => setDrag(null)}
                          className={cn(
                            'absolute flex items-center gap-1 overflow-hidden rounded-[6px] px-1.5 text-left text-xs select-none',
                            b.run
                              ? 'bg-secondary text-muted-foreground hover:bg-secondary/80'
                              : 'bg-primary/10 hover:bg-primary/15',
                            canMove && 'cursor-grab touch-none',
                            dragging && 'z-10 cursor-grabbing bg-primary/20 shadow-md',
                          )}
                          style={place(b.day, b.minute, b.lane, b.lanes)}
                        >
                          {b.run && (
                            <span
                              className={cn(
                                'size-1.5 shrink-0 rounded-full',
                                OUTCOME[b.run.outcome].dot,
                              )}
                            />
                          )}
                          <span className="min-w-0 truncate">
                            <span className="font-semibold">{s.title}</span>{' '}
                            <span className="text-muted-foreground">{hhmm(b.minute)}</span>
                          </span>
                          <DropdownMenuTrigger asChild>
                            <span aria-hidden className="pointer-events-none absolute inset-0" />
                          </DropdownMenuTrigger>
                        </button>
                        {menuFor(b)}
                      </DropdownMenu>
                    )
                  })}
                </div>
              </div>
            </div>
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
