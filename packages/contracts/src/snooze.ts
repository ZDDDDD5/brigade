// Snooze: a member puts a thread away for themselves until a time they pick (apps/api/src/later.ts,
// Later in the code and the database). The menu's choices are times in the member's own day,
// read from the browser's clock and time zone; the API keeps only the instant.

/** Further than this is refused: a month away, with room for the longest month and a clock change. */
export const SNOOZE_MAX_DAYS = 32

export type SnoozeOption = { key: string; label: string; until: Date }

/** Hour a day-based choice wakes at, local time. */
const MORNING = 9

const at = (day: Date, hour: number) => {
  const d = new Date(day)
  d.setHours(hour, 0, 0, 0)
  return d
}

/**
 * The menu's choices, from `now` in the local time zone: in 1 and 3 hours, tomorrow at 9:00,
 * next Monday at 9:00 (a week on, on a Monday) and in a month (the same day and time next month,
 * or that month's last day).
 */
export function snoozeOptions(now = new Date()): SnoozeOption[] {
  const hours = (n: number) => new Date(now.getTime() + n * 3_600_000)
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const monday = new Date(now)
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7))
  const month = new Date(now)
  month.setDate(1)
  month.setMonth(now.getMonth() + 1)
  const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  month.setDate(Math.min(now.getDate(), lastDay))
  return [
    { key: '1h', label: '1 hour', until: hours(1) },
    { key: '3h', label: '3 hours', until: hours(3) },
    { key: 'tomorrow', label: 'Tomorrow', until: at(tomorrow, MORNING) },
    { key: 'next-week', label: 'Next week', until: at(monday, MORNING) },
    { key: 'month', label: '1 month', until: month },
  ]
}
