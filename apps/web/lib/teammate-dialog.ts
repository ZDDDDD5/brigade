// A teammate's settings are a dialog over the page the member is on (components/teammate-dialog.tsx),
// as Settings are. Its address, /app/teammates/<id>, still opens it: a plain click on a link to it
// opens the dialog in place (TeammateDialog catches it), and the address loaded on its own (a new
// tab, an email) opens it over Today (TeammateAddress). The form for a new teammate is the same
// dialog, at /app/teammates/new (NEW_TEAMMATE).
import { useSyncExternalStore } from 'react'

export type TeammateTab = 'profile' | 'access' | 'activity' | 'limits'
export type TeammateShown = { id: string; tab: TeammateTab | null }

/** The id the dialog shows the new-teammate form for: never a real teammate's (they are cuids). */
export const NEW_TEAMMATE = 'new'

/**
 * Sent on window once the form made a teammate, with its id: the sidebar narrows its threads to
 * it, as a click on its row does.
 */
export const TEAMMATE_CREATED = 'brigade:teammate-created'

const TABS = new Set<string>(['profile', 'access', 'activity', 'limits'])

/** The teammate (and tab) an address opens, or null for any other address. */
export function teammateAddress(href: string): TeammateShown | null {
  let url: URL
  try {
    url = new URL(href, 'https://here.invalid')
  } catch {
    return null
  }
  const here = typeof location === 'undefined' ? undefined : location.origin
  if (url.origin !== 'https://here.invalid' && url.origin !== here) return null
  const id = /^\/app\/teammates\/([^/]+)\/?$/.exec(url.pathname)?.[1]
  if (!id) return null
  if (id === NEW_TEAMMATE) return { id, tab: null }
  const tab = url.searchParams.get('tab')
  return { id: decodeURIComponent(id), tab: tab && TABS.has(tab) ? (tab as TeammateTab) : null }
}

let shown: TeammateShown | null = null
const listeners = new Set<() => void>()
function show(next: TeammateShown | null) {
  shown = next
  listeners.forEach((l) => l())
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

let hosts = 0
/** The dialogs mounted to show a teammate: without one, its links go to its address. */
export function hostTeammate() {
  hosts++
  return () => void hosts--
}

/** Open a teammate's settings in place; false, doing nothing, where no dialog can show them. */
export function openTeammate(id: string, tab: TeammateTab | null = null) {
  if (!hosts) return false
  show({ id, tab })
  return true
}

/** Its address loaded on its own: shown even before the dialog mounts. */
export function showTeammate(href: string) {
  const at = teammateAddress(href)
  if (at) show(at)
}

/** Move the open dialog to another tab. */
export function setTeammateTab(tab: TeammateTab) {
  if (shown) show({ ...shown, tab })
}

export function closeTeammate() {
  show(null)
}

/** The teammate shown, or null while the dialog is closed. */
export function useTeammateDialog() {
  return useSyncExternalStore(
    subscribe,
    () => shown,
    () => null,
  )
}
