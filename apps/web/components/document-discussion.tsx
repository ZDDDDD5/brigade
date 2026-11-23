'use client'
// Talking with a teammate about a library file, from the file: in the thread that
// last changed it, which knows why it says what it says, else in a new thread. The
// thread opens as the page, the file stays beside it, and the reply box holds the
// file's mention (and the passage asked about) for the person to finish and send.
import { formatMention } from '@brigade/contracts'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDashboard } from '@/components/dashboard'
import { useThreadPanel } from '@/components/thread-panel'
import { api, type LibraryVersion, type Teammate, type Thread } from '@/lib/api'
import { addToReply, replyDraft } from '@/lib/reply-drafts'
import { useLive } from '@/lib/use-live'

export type DocumentDiscussion = {
  /** Who answers: the teammate that last changed the file, else the one picked last. */
  teammate: { id: string; name: string } | null
  /** Opens the thread with the file, and `passage` quoted, in its reply box. */
  ask: (passage?: string) => Promise<void>
}

/** A passage as a quote, a line each, blank lines dropped. */
const quote = (passage: string) =>
  passage
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `> ${line}`)
    .join('\n')

type Actor = LibraryVersion['by']
/** The teammate that saved the file last, and the one that saved it last from a thread. */
type Saver = { teammate: Actor | null; thread: Actor | null }

/** From the file's versions, newest first. */
const savedBy = (fileId: string): Promise<Saver> =>
  api<LibraryVersion[]>(`/library/${fileId}/versions`).then(
    (versions) => {
      const byTeammates = versions.filter((v) => v.by.type === 'teammate')
      return {
        teammate: byTeammates[0]?.by ?? null,
        thread: byTeammates.find((v) => v.by.sessionId)?.by ?? null,
      }
    },
    () => ({ teammate: null, thread: null }),
  )

type Saved = { by: Saver; thread: Thread | null }

/** Who saved the file, and the thread that saved it last, when the person can still open it. */
async function savedWith(fileId: string): Promise<Saved> {
  const by = await savedBy(fileId)
  const id = by.thread?.sessionId
  const thread = id ? await api<Thread>(`/threads/${id}`).catch(() => null) : null
  return { by, thread }
}

/**
 * Who answers: the teammate of the thread Ask opens, else the one that saved the file last
 * (in a new thread), while each is still one; else the one picked last, else the first.
 */
function answerer(teammates: Teammate[], by: Saver | undefined, picked: string | undefined) {
  const t =
    teammates.find((t) => t.id === by?.thread?.id) ??
    teammates.find((t) => t.id === by?.teammate?.id) ??
    teammates.find((t) => t.id === picked) ??
    teammates[0]
  return t ? { id: t.id, name: t.name } : null
}

/** For a library file; null for anything else (memory). */
export function useDocumentDiscussion(
  file: { id: string; path: string } | null,
): DocumentDiscussion | null {
  const { teammates } = useDashboard()
  const panel = useThreadPanel()
  // Who saved it last, for the button's name: kept with the file it is for, so
  // another file's never shows while the new one's loads, nor after its load failed.
  const fileId = file?.id
  // With the thread Ask opens, fetched with it: a click then opens it at once, without
  // waiting on the API (the click was 1 to 3 seconds of two requests in a row).
  const [saved, setSaved] = useState<Saved & { fileId: string }>()
  const [changes, setChanges] = useState(0)
  useLive((message) => {
    if (message.type === 'library.updated') setChanges((n) => n + 1)
  })
  useEffect(() => {
    if (!fileId) return
    let current = true
    void savedWith(fileId).then((got) => current && setSaved({ fileId, ...got }))
    return () => {
      current = false
    }
  }, [fileId, changes])
  const known = saved?.fileId === fileId ? saved : undefined
  const last = known?.by
  const { teammateId: picked } = panel
  const teammate = useMemo(() => answerer(teammates, last, picked), [teammates, last, picked])

  const { openThread, draft, chooseTeammate, newThreadPage } = panel
  const ask = useCallback(
    async (passage?: string) => {
      if (!file) return
      const mention = formatMention({ kind: 'document', id: file.id, label: file.path })
      // The file once per message; a passage on its own lines, the cursor on the next.
      const text = (has: string) => {
        const named = has.includes(`(document:${file.id})`)
        if (!passage) return named ? '' : `${mention} `
        return [...(named ? [] : [mention]), quote(passage)].join('\n') + '\n'
      }
      // The thread that last changed this file, as loaded with the file and kept up to date as
      // the library changes; asked now only when that has not come yet.
      const { by, thread }: Saved = known ?? (await savedWith(file.id))
      const threadId = by.thread?.sessionId
      if (thread?.mayPrompt && threadId) {
        const added = text(replyDraft(threadId))
        if (added) addToReply(threadId, added)
        openThread(threadId)
        return
      }
      const to = answerer(teammates, by, picked)
      if (to) chooseTeammate(to.id)
      // Added to what the box holds as this runs: the person may have typed meanwhile.
      draft.setText((held) => {
        const current = held.trimEnd()
        const added = text(current)
        return added ? (current ? `${current}\n${added}` : added) : held
      })
      newThreadPage()
    },
    [file, known, teammates, picked, openThread, draft, chooseTeammate, newThreadPage],
  )
  return useMemo(() => (file ? { teammate, ask } : null), [file, teammate, ask])
}
