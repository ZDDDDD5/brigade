// Pin and Unpin show at once: the thread moves under Pinned, or back, as it is clicked, while
// the request goes. Each thread's requests go one after another, the latest wish last, so a
// quick Pin then Unpin ends unpinned on the server too. The shown state holds until every
// request is in and the list was asked for again, which then says the same; a refused one
// leaves the list as the server has it.
import { useSyncExternalStore } from 'react'

export type ShownPin = { pinnedAt: string | null; pinPosition: number | null }

/** Shown in place of what the list says, per thread. Replaced whole on each change. */
let shown: ReadonlyMap<string, ShownPin> = new Map()
/** The wish of each thread whose requests are going: the running loop sends the latest. */
const wishes = new Map<string, { pinned: boolean }>()
const listeners = new Set<() => void>()

function show(id: string, pin: ShownPin | undefined) {
  const next = new Map(shown)
  if (pin) next.set(id, pin)
  else next.delete(id)
  shown = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Pins or unpins it, shown at once. `send` makes the request; `reload` asks for the lists
 * again once all are in. Rejects with the request's error, once the list is reloaded.
 */
export async function setPinned(
  id: string,
  pinned: boolean,
  send: (pinned: boolean) => Promise<unknown>,
  reload: () => unknown,
) {
  // Pinned last, at the end of Pinned, as the API places it (nextPinPosition).
  show(
    id,
    pinned
      ? { pinnedAt: new Date().toISOString(), pinPosition: Number.MAX_SAFE_INTEGER }
      : { pinnedAt: null, pinPosition: null },
  )
  const going = wishes.get(id)
  if (going) {
    going.pinned = pinned
    return
  }
  const wish = { pinned }
  wishes.set(id, wish)
  let sent: boolean | undefined
  let error: unknown
  try {
    while (sent !== wish.pinned) {
      const next = wish.pinned
      await send(next)
      sent = next
    }
  } catch (e) {
    error = e
  } finally {
    // A click from here on starts its own requests.
    wishes.delete(id)
  }
  try {
    await reload()
  } finally {
    // Unless a click since then shows its own.
    if (!wishes.has(id)) show(id, undefined)
  }
  if (error !== undefined) throw error
}

/** What the thread shows while its pin changes, else undefined. */
export function shownPin(id: string): ShownPin | undefined {
  return shown.get(id)
}

/** Every pin shown ahead of the server, live. */
export function useShownPins(): ReadonlyMap<string, ShownPin> {
  return useSyncExternalStore(
    subscribe,
    () => shown,
    () => shown,
  )
}

/** The thread as it shows: with the pin it is changing to, if any. */
export function withShownPin<T extends { id: string; pinnedAt?: string | null }>(
  thread: T,
  pins: ReadonlyMap<string, ShownPin>,
): T {
  const pin = pins.get(thread.id)
  return pin ? { ...thread, ...pin } : thread
}
