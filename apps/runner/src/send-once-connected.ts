// A report read between connects (machine.logins, once the runner's own Claude Code is installed)
// is read once the API welcomed this runner, and sent only on that same connection: one read
// while away, or across a reconnect, could be older than what a hello since said (a sign-out
// meanwhile). A reconnect during the read hands the report to that hello, which read the same
// machine anew; a send refused on the same connection waits and reads again.
import { setTimeout as sleep } from 'node:timers/promises'

export async function sendOnceConnected<T>(
  welcome: () => number | undefined,
  read: () => Promise<T>,
  send: (value: T) => boolean,
  options: { everyMs?: number; tries?: number } = {},
): Promise<'sent' | 'superseded' | 'gave up'> {
  const { everyMs = 5_000, tries = 720 } = options
  for (let i = 0; i < tries; i++) {
    const before = welcome()
    if (before !== undefined) {
      const value = await read()
      const now = welcome()
      // Welcomed again meanwhile: that hello carried what is true now.
      if (now !== undefined && now !== before) return 'superseded'
      if (now === before && send(value)) return 'sent'
    }
    await sleep(everyMs)
  }
  return 'gave up'
}
