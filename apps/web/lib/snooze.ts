// How a snooze's end reads (contracts' snooze.ts has the menu's choices): the time alone today,
// "Tomorrow 9:00", a weekday this week, else the date.
const DAY = 86_400_000

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

export function wakeLabel(until: Date | string, now = new Date()) {
  const at = new Date(until)
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY)
  if (days <= 0) return time
  if (days === 1) return `Tomorrow ${time}`
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
