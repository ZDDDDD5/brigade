// The teammate new messages go to, remembered per browser (components/new-thread.tsx's
// useLastTeammate). Apart from that component, so onboarding sets it without loading it.

export const LAST_TEAMMATE = 'brigade.home.teammate'

/** The teammate remembered, read at once. */
export function lastTeammate() {
  try {
    return localStorage.getItem(LAST_TEAMMATE) ?? undefined
  } catch {
    return undefined
  }
}

/** Make `id` the teammate new messages go to: onboarding opens the threads page on Chief. */
export function rememberTeammate(id: string) {
  try {
    localStorage.setItem(LAST_TEAMMATE, id)
  } catch {}
}
