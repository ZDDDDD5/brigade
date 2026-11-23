// A report read between connects (machine.logins, once the runner's own Claude Code is installed)
// is sent once the API welcomed this runner, and read at that moment, not before: one read while
// it was away could be older than what a hello since said (a sign-out meanwhile). A connection
// lost between the read and the send makes it wait and read again.
import { setTimeout as sleep } from 'node:timers/promises'

export async function sendOnceConnected(
  connected: () => boolean,
  readAndSend: () => Promise<boolean>,
  options: { everyMs?: number; tries?: number } = {},
): Promise<boolean> {
  const { everyMs = 5_000, tries = 720 } = options
  for (let i = 0; i < tries; i++) {
    if (connected() && (await readAndSend())) return true
    await sleep(everyMs)
  }
  return false
}
