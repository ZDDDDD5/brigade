// Where elements picked in a tool go: the composer of a thread open on the page. Each thread's
// conversation says it is there while it shows (its composer keeps elements picked in its
// preview, and now in a tool); a tool beside a thread picks for that one, a tool in the document
// panel for the thread open last. Kept while the dashboard is open, like pending-edits.ts.
import { useSyncExternalStore, type RefObject } from 'react'
import type { PickHandlers } from '@/components/preview-panel'

export type ElementPicker = { threadId: string; handlers: RefObject<PickHandlers> }

let pickers: ElementPicker[] = []
const listeners = new Set<() => void>()

function changed() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A thread's composer takes picked elements until the returned function is called. */
export function registerElementPicker(threadId: string, handlers: RefObject<PickHandlers>) {
  const picker = { threadId, handlers }
  pickers = [...pickers, picker]
  changed()
  return () => {
    pickers = pickers.filter((p) => p !== picker)
    changed()
  }
}

/** That thread's composer, when it shows; without one, the thread open last. */
export function useElementPicker(threadId: string | undefined): ElementPicker | undefined {
  return useSyncExternalStore(
    subscribe,
    () =>
      threadId ? pickers.findLast((p) => p.threadId === threadId) : pickers[pickers.length - 1],
    () => undefined,
  )
}
