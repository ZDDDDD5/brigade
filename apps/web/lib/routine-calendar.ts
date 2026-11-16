// Routines as a week calendar: each schedule's runs placed in the browser's own week, and a run
// dragged to another time written back as the schedule's cron, in the schedule's timezone.
import { nextRuns } from '@brigade/contracts'

const DAY_MS = 86_400_000

/** Monday 00:00 of the week `date` falls in, in the browser's timezone. */
export function weekStart(date: Date) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  return addDays(day, -((day.getDay() + 6) % 7))
}

/** `date` moved by whole calendar days, keeping its wall-clock time across DST changes. */
export function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

/** Calendar days from the week's `start` to `date`: 0 Monday … 6 Sunday within that week. */
export const dayIndex = (date: Date, start: Date) =>
  Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - start.getTime()) /
      DAY_MS,
  )

/** Minutes since midnight, in the browser's timezone. */
export const minuteOfDay = (date: Date) => date.getHours() * 60 + date.getMinutes()

/** A schedule runs at most this many times a calendar day to be drawn at its times. */
export const MAX_DRAWN_PER_DAY = 3

/**
 * Its runs from `from` (included) to `to` (excluded), at most `limit`; `frequent` when some day
 * holds more than MAX_DRAWN_PER_DAY of them (an hourly routine goes in the band above the hours).
 */
export function runsBetween(cron: string, timezone: string, from: Date, to: Date, limit = 100) {
  let runs: Date[]
  try {
    runs = nextRuns(cron, timezone, limit, new Date(from.getTime() - 1000))
  } catch {
    return { runs: [], frequent: false }
  }
  const within = runs.filter((run) => run >= from && run < to)
  const perDay = new Map<string, number>()
  for (const run of within) {
    const key = run.toDateString()
    perDay.set(key, (perDay.get(key) ?? 0) + 1)
  }
  const frequent =
    [...perDay.values()].some((n) => n > MAX_DRAWN_PER_DAY) ||
    (runs.length === limit && within.length === limit)
  return { runs: within, frequent }
}

/** The rhythms a drag can change, as the New schedule dialog writes them. */
export type Movable =
  | { kind: 'daily' | 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; hour: number; minute: number; day: number }

/** What a cron can be dragged as, or null when only the dialog can change it (custom, hourly). */
export function movableOf(cron: string): Movable | null {
  const m = cron.trim().match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/)
  if (!m) return null
  const [minute, hour] = [Number(m[1]), Number(m[2])]
  if (minute > 59 || hour > 23) return null
  if (m[3] === '*') return { kind: 'daily', hour, minute }
  if (m[3] === '1-5') return { kind: 'weekdays', hour, minute }
  return { kind: 'weekly', hour, minute, day: Number(m[3]) }
}

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const

/** The wall-clock time and weekday (0 Sunday) of an instant in a timezone. */
export function zonedClock(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    hour: Number(part('hour')) % 24,
    minute: Number(part('minute')),
    day: WEEKDAY[part('weekday') as keyof typeof WEEKDAY],
  }
}

/**
 * The cron of a routine whose run was dropped at `to`, read in the schedule's own timezone: the
 * time always moves; the day only for a weekly one (every day and weekdays keep their days).
 */
export function movedCron(movable: Movable, to: Date, timezone: string) {
  const { hour, minute, day } = zonedClock(to, timezone)
  if (movable.kind === 'daily') return `${minute} ${hour} * * *`
  if (movable.kind === 'weekdays') return `${minute} ${hour} * * 1-5`
  return `${minute} ${hour} * * ${day}`
}

/** A weekly cron at a slot of the calendar, in the browser's timezone (a new routine's default). */
export function slotCron(date: Date) {
  return `${date.getMinutes()} ${date.getHours()} * * ${date.getDay()}`
}

/**
 * One day's runs stacked into cards, in time order: a run joins the card above when it would start
 * before that card ends (each run a row `rowMinutes` tall), so runs close in time read as a list
 * rather than squeezed side by side.
 */
export function stackOut<T extends { minute: number }>(items: T[], rowMinutes: number) {
  const cards: { minute: number; items: T[] }[] = []
  for (const item of [...items].sort((a, b) => a.minute - b.minute)) {
    const last = cards.at(-1)
    if (last && item.minute < last.minute + last.items.length * rowMinutes) last.items.push(item)
    else cards.push({ minute: item.minute, items: [item] })
  }
  return cards
}

type Firing = {
  cron: string
  timezone: string
  lastError: string | null
  pausedAt: string | null
  createdAt: string
  /** Oldest first. */
  recentRuns: { createdAt: string }[]
}

/**
 * The times its cron planned in [from, to) that started no run: while its last firing could not
 * start (`lastError`), every firing since its last run started (or since it was made).
 */
export function missedRuns(schedule: Firing, from: Date, to: Date) {
  if (!schedule.lastError || schedule.pausedAt) return []
  const last = schedule.recentRuns.at(-1)
  const since = Math.max(
    from.getTime(),
    new Date(schedule.createdAt).getTime(),
    last ? new Date(last.createdAt).getTime() + 60_000 : 0,
  )
  if (since >= to.getTime()) return []
  return runsBetween(schedule.cron, schedule.timezone, new Date(since), to).runs
}

/**
 * The hours the grid shows, [from, to): those around its runs and the time now, at least `least`
 * of them; the rest fold away. With nothing to show, the working day.
 */
export function hoursShown(minutes: number[], least = 6) {
  if (!minutes.length) return { from: 8, to: 18 }
  let from = Math.max(0, Math.floor(Math.min(...minutes) / 60) - 1)
  let to = Math.min(24, Math.floor(Math.max(...minutes) / 60) + 2)
  if (to - from < least) to = Math.min(24, from + least)
  if (to - from < least) from = Math.max(0, to - least)
  return { from, to }
}
