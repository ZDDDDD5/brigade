// Settings is a dialog over the page the member is on (components/settings-dialog.tsx). Each
// section keeps its address, /app/<section>, which opens it: a link to it inside the app opens
// the dialog in place (clickSettings, openSettings), and loaded on its own (a new tab, a
// provider's redirect, an email) it opens over Today. What followed `?` in the address goes to
// the section (useSettingsParams), as it would have to a page.
import { useSyncExternalStore, type MouseEvent } from 'react'

/** Settings' sections, in their groups: the member's own, the workspace's, what teammates work with. */
export const SETTINGS_SECTIONS = [
  {
    section: 'preferences',
    label: 'Preferences',
    group: 'You',
    keywords:
      'suggest next message auto-merge pull request heavy work machine chief rules daily pass delete account',
  },
  { section: 'notifications', label: 'Notifications', group: 'You', keywords: 'push alerts phone' },
  {
    section: 'accounts',
    label: 'AI Accounts',
    group: 'You',
    keywords: 'claude codex chatgpt subscription sign in',
  },
  {
    section: 'workspace',
    label: 'General',
    group: 'Workspace',
    keywords: 'workspace name logo delete workspace',
    // In the app's search, where "General" alone would say nothing.
    search: 'Workspace',
  },
  { section: 'members', label: 'Members', group: 'Workspace', keywords: 'invite role people' },
  {
    section: 'computers',
    label: 'Computers',
    group: 'Workspace',
    keywords: 'cloud computer machine link desktop mac windows linux',
  },
  { section: 'usage', label: 'Usage', group: 'Workspace', keywords: 'limits spent models threads' },
  {
    section: 'billing',
    label: 'Billing',
    group: 'Workspace',
    keywords: 'plan brigade cloud subscribe invoices card',
  },
  {
    section: 'connections',
    label: 'Apps',
    group: 'Teammates',
    keywords: 'connections connect integrations mcp triggers github gmail',
  },
  { section: 'skills', label: 'Skills', group: 'Teammates', keywords: 'procedures instructions' },
  {
    section: 'vault',
    label: 'Secrets',
    group: 'Teammates',
    keywords: 'vault credentials passwords logins keys',
  },
  {
    section: 'security',
    label: 'Security',
    group: 'Teammates',
    keywords: 'access permissions activity',
  },
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['section']

/** A section's address. */
export const settingsHref = (section: SettingsSection) => `/app/${section}`

/** Settings open on a section, with what its address had after `?`. */
export type SettingsShown = { section: SettingsSection; params: URLSearchParams }

const SECTIONS = new Set<string>(SETTINGS_SECTIONS.map((s) => s.section))

/**
 * The section an address opens, or null for any other address: /app/settings opens the first.
 * A full URL counts only on this site.
 */
export function settingsAddress(href: string): SettingsShown | null {
  let url: URL
  try {
    url = new URL(href, 'https://here.invalid')
  } catch {
    return null
  }
  if (url.origin !== 'https://here.invalid' && url.origin !== currentOrigin()) return null
  const name = /^\/app\/([^/]+)\/?$/.exec(url.pathname)?.[1]
  const section = name === 'settings' ? SETTINGS_SECTIONS[0].section : name
  if (!section || !SECTIONS.has(section)) return null
  return { section: section as SettingsSection, params: url.searchParams }
}

const currentOrigin = () => (typeof location === 'undefined' ? undefined : location.origin)

/** The sections a search finds: each word in its name, group or what it holds. */
export function searchSettings(query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return SETTINGS_SECTIONS.filter((s) => {
    const text = `${s.label} ${s.group} ${s.section} ${s.keywords}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

let shown: SettingsShown | null = null
const listeners = new Set<() => void>()
function show(next: SettingsShown | null) {
  shown = next
  listeners.forEach((l) => l())
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/**
 * Open Settings in place, on the section an address names (the first by default), or move it to
 * that section. Returns false, doing nothing, for an address that is no section's.
 */
export function openSettings(href = '/app/settings') {
  const at = settingsAddress(href)
  if (at) show(at)
  return !!at
}

export function closeSettings() {
  show(null)
}

/** The section shown, or null while Settings is closed. */
export function useSettings() {
  return useSyncExternalStore(
    subscribe,
    () => shown,
    () => null,
  )
}

const NONE = new URLSearchParams()

/** What the section's address had after `?` (`?app=cloudflare`, `?subscribed=1`): a section's useSearchParams. */
export function useSettingsParams() {
  return useSettings()?.params ?? NONE
}

/**
 * A link's onClick: a plain click on a section's address opens it in place; one that opens a new
 * tab or window (or that a child already took), and any other address, is left as it is.
 */
export function clickSettings(e: MouseEvent<HTMLAnchorElement>, href: string) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return
  if (openSettings(href)) e.preventDefault()
}
