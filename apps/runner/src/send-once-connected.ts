// A report made between connects (machine.logins, once the runner's own Claude Code is installed)
// may come before the API welcomed this runner, or while it is away: sendIfConnected refuses it
// then. It is kept and tried again until taken; a later hello carries the same anyway.
import { setTimeout as sleep } from 'node:timers/promises'

export async function sendOnceConnected(
  send: () => boolean,
  options: { everyMs?: number; tries?: number } = {},
): Promise<boolean> {
  const { everyMs = 5_000, tries = 720 } = options
  for (let i = 0; i < tries; i++) {
    if (send()) return true
    await sleep(everyMs)
  }
  return false
}
