// A thread's Pin, Snooze, Done and Archive show at once: the row moves (under Pinned, out of
// the list, into Snoozed) as it is clicked, while the request goes. Each thread's requests for
// one change go one after another, the latest wish last, so a quick Pin then Unpin ends
// unpinned on the server too. The shown state holds until every request is in and the list
// was asked for again, which then says the same; a refused one leaves the list as the server
// has it.
import { useSyncExternalStore } from 'react'

/** What a change shows in place of what the list says. */
export type ShownThread = {
  pinnedAt?: string | null
  pinPosition?: number | null
  laterAt?: string | null
  snoozedUntil?: string | null
  doneAt?: string | null
  archivedAt?: string | null
}

/** The changes that show at once: each has its own queue of requests per thread. */
export type ThreadChange = 'pin' | 'later' | 'done' | 'archive'

/** Shown in place of what the list says, per thread: every change going, together. */
let shown: ReadonlyMap<string, ShownThread> = new Map()
/** What each change going shows, by thread then change. */
const byChange = new Map<string, Map<ThreadChange, ShownThread>>()
/** The wish of each thread's change whose requests are going: the running loop sends the latest. */
const wishes = new Map<string, { value: unknown }>()
const listeners = new Set<() => void>()

const wishKey = (id: string, change: ThreadChange) => `${id}\u0000${change}`

function show(id: string, change: ThreadChange, fields: ShownThread | undefined) {
  const changes = new Map(byChange.get(id))
  if (fields) changes.set(change, fields)
  else changes.delete(change)
  if (changes.size) byChange.set(id, changes)
  else byChange.delete(id)
  const next = new Map(shown)
  if (changes.size) next.set(id, Object.assign({}, ...changes.values()) as ShownThread)
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
 * Makes a change to a thread, shown at once as `fields`. `send` makes the request for a wish;
 * `reload` asks for the lists again once all are in. Rejects with the request's error, once
 * the list is reloaded. A second call for the same thread and change while one goes only
 * changes the wish: the running one sends it next, and the second call returns at once.
 */
export async function changeThread<W>(
  id: string,
  change: ThreadChange,
  wish: W,
  fields: ShownThread,
  send: (wish: W) => Promise<unknown>,
  reload: () => unknown,
) {
  show(id, change, fields)
  const key = wishKey(id, change)
  const going = wishes.get(key)
  if (going) {
    going.value = wish
    return
  }
  const latest = { value: wish as unknown }
  wishes.set(key, latest)
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  let sent: { value: unknown } | undefined
  let error: unknown
  try {
    while (!sent || !same(sent.value, latest.value)) {
      const next = latest.value as W
      await send(next)
      sent = { value: next }
    }
  } catch (e) {
    error = e
  } finally {
    // A click from here on starts its own requests.
    wishes.delete(key)
  }
  try {
    await reload()
  } finally {
    // Unless a click since then shows its own.
    if (!wishes.has(key)) show(id, change, undefined)
  }
  if (error !== undefined) throw error
}

/** Pins or unpins it, shown at once (changeThread). */
export function setPinned(
  id: string,
  pinned: boolean,
  send: (pinned: boolean) => Promise<unknown>,
  reload: () => unknown,
) {
  // Pinned last, at the end of Pinned, as the API places it (nextPinPosition).
  return changeThread(
    id,
    'pin',
    pinned,
    pinned
      ? { pinnedAt: new Date().toISOString(), pinPosition: Number.MAX_SAFE_INTEGER }
      : { pinnedAt: null, pinPosition: null },
    send,
    reload,
  )
}

/** What the thread shows while it changes, else undefined. */
export function shownThread(id: string): ShownThread | undefined {
  return shown.get(id)
}

/** Every change shown ahead of the server, live. */
export function useShownThreads(): ReadonlyMap<string, ShownThread> {
  return useSyncExternalStore(
    subscribe,
    () => shown,
    () => shown,
  )
}

/** The thread as it shows: with the changes going, if any. */
export function withShown<T extends { id: string }>(
  thread: T,
  changes: ReadonlyMap<string, ShownThread>,
): T {
  const fields = changes.get(thread.id)
  return fields ? { ...thread, ...fields } : thread
}
