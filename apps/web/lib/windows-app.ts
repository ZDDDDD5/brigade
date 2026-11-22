'use client'
import { useEffect, useState } from 'react'

/** Brigade.app for Windows (apps/desktop's installer), from the latest GitHub release
 * (.github/workflows/desktop-release.yml uploads it as Brigade-Setup.exe). */
export const WINDOWS_APP_URL =
  'https://github.com/gmpetrov/brigade/releases/latest/download/Brigade-Setup.exe'

/**
 * What to do when the browser or SmartScreen warns about the installer, which is not code-signed
 * yet (.github/workflows/desktop-release.yml): without it, a person can stop at that warning.
 */
export const WINDOWS_UNSIGNED_HINT =
  "Your browser or Windows may warn about the installer, as it isn't signed yet: keep the file, then choose More info and Run anyway."

/** The first Brigade.app that runs teammates on Windows: those before only show the dashboard. */
export const WINDOWS_RUNNER_SINCE = '0.4.6'

/** Whether a version (1.2.3, or a desktop-v1.2.3 tag) is at least `min`. */
export function versionAtLeast(version: string, min: string) {
  const parts = (v: string) =>
    v
      .replace(/^desktop-v|^v/, '')
      .split('.')
      .map(Number)
  const [a, b] = [parts(version), parts(min)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (Number.isNaN(d)) return false
    if (d !== 0) return d > 0
  }
  return true
}

/**
 * Whether the Brigade.app a Windows download gets now runs teammates there: the latest release,
 * from GitHub's API (which the browser may call). Undefined until known; false when GitHub does
 * not say, so a page never offers an app that would not run them.
 */
export function useWindowsAppReady() {
  const [ready, setReady] = useState<boolean>()
  useEffect(() => {
    let live = true
    fetch('https://api.github.com/repos/gmpetrov/brigade/releases/latest', {
      headers: { accept: 'application/vnd.github+json' },
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ tag_name?: string }>) : {}))
      .then((release: { tag_name?: string }) => {
        if (live)
          setReady(!!release.tag_name && versionAtLeast(release.tag_name, WINDOWS_RUNNER_SINCE))
      })
      .catch(() => live && setReady(false))
    return () => {
      live = false
    }
  }, [])
  return ready
}
