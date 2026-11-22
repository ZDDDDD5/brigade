'use client'
// A thread's preview, or a library tool or design open beside it, kept while the person is on another
// thread: its frame stays in the page, hidden, so coming back finds the app as it was left (the
// page, what was typed, where it was scrolled), not loaded again. A browser loads a frame again
// whenever it leaves the page, so the panels are rendered here, by the dashboard, rather than by
// the thread's conversation, which goes when the thread does: the conversation hands its panel's
// props over (KeepPreview, KeepTool, KeepDesign) and the dashboard renders them (KeptPreviews).
// The latest few hidden ones of each kind are kept, since each still runs its page in this tab;
// one closed, or replaced by something else beside its thread, goes.
import { useLayoutEffect, useSyncExternalStore, type ComponentType } from 'react'
import { DesignFolderPanel } from '@/components/file-panel'
import { PreviewPanel } from '@/components/preview-panel'
import { ToolPanel } from '@/components/tool-view'

/** Hidden ones kept at most, of each kind: the latest left. */
const MAX_HIDDEN = 3

const listeners = new Set<() => void>()
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
function notify() {
  for (const listener of listeners) listener()
}

/** `seen`: when it last showed, for which hidden ones go first. */
type Kept<P> = { threadId: string; props: P; shown: boolean; seen: number }

/** One kind of panel kept per thread, and the component that renders it. */
function keeper<P extends { threadId: string }>(
  Panel: ComponentType<P & { hidden: boolean }>,
  /** Its key in the page: a new one is a new panel, its frame loaded anew. */
  keyOf: (props: P) => string,
) {
  // In the order they came, never moved: a frame moved in the page loads again too. Which
  // one is in front is the panels' stack (components/side-panel.tsx), not this order.
  let kept: Kept<P>[] = []
  let clock = 0
  const NONE: Kept<P>[] = []
  const set = (next: Kept<P>[]) => {
    kept = next
    notify()
  }

  function show(props: P, shown: boolean) {
    const was = kept.find((k) => k.threadId === props.threadId)
    // Its thread open, shown or not: the latest, so never the one to go.
    const entry = { threadId: props.threadId, props, shown, seen: ++clock }
    set(was ? kept.map((k) => (k === was ? entry : k)) : [...kept, entry])
    if (!shown) trim()
  }

  function hide(threadId: string) {
    if (!kept.some((k) => k.threadId === threadId && k.shown)) return
    set(kept.map((k) => (k.threadId === threadId ? { ...k, shown: false, seen: ++clock } : k)))
    trim()
  }

  /** The hidden ones over MAX_HIDDEN go, those shown longest ago first. */
  function trim() {
    const hidden = kept.filter((k) => !k.shown).sort((a, b) => a.seen - b.seen)
    const over = new Set(hidden.slice(0, Math.max(0, hidden.length - MAX_HIDDEN)))
    if (over.size) set(kept.filter((k) => !over.has(k)))
  }

  /** The thread's panel, no longer kept: closed, or something else beside the thread. */
  function drop(threadId: string) {
    if (kept.some((k) => k.threadId === threadId)) set(kept.filter((k) => k.threadId !== threadId))
  }

  /**
   * In the conversation, where its panel would be: hands the panel over to the dashboard,
   * shown or hidden; going (the thread left), the panel stays, hidden.
   */
  function Keep({ shown, ...props }: P & { shown: boolean }) {
    const threadId = props.threadId
    // Each render: its callbacks and what it shows as it stands. Before the browser paints, so
    // the page makes room for it in the same frame (and the thread's pill slides across).
    useLayoutEffect(() => show(props as unknown as P, shown))
    useLayoutEffect(() => () => hide(threadId), [threadId])
    return null
  }

  const anyShown = () => kept.some((k) => k.shown)

  function Kept() {
    const list = useSyncExternalStore(
      subscribe,
      () => kept,
      () => NONE,
    )
    return list.map(({ props, shown }) => <Panel key={keyOf(props)} {...props} hidden={!shown} />)
  }

  return { Keep, Kept, drop, anyShown }
}

type PreviewProps = Omit<Parameters<typeof PreviewPanel>[0], 'hidden'>
const previews = keeper<PreviewProps>(PreviewPanel, (p) => p.threadId)

type ToolProps = { threadId: string; folder: string; onClose: () => void }
const tools = keeper<ToolProps>(ToolPanel, (p) => `${p.threadId}:${p.folder}`)

export const KeepPreview = previews.Keep
export const dropKeptPreview = previews.drop
export const KeepTool = tools.Keep
export const dropKeptTool = tools.drop

type DesignProps = { threadId: string; folder: string; onClose: () => void }
const designs = keeper<DesignProps>(DesignFolderPanel, (p) => `${p.threadId}:${p.folder}`)

export const KeepDesign = designs.Keep
export const dropKeptDesign = designs.drop

/** Whether a kept panel shows: changes as one opens or closes beside the page. */
export function useKeptPanelShown() {
  return useSyncExternalStore(
    subscribe,
    () => previews.anyShown() || tools.anyShown() || designs.anyShown(),
    () => false,
  )
}

/** The panels, rendered once by the dashboard: those shown, and those kept hidden. */
export function KeptPreviews() {
  return (
    <>
      <previews.Kept />
      <tools.Kept />
      <designs.Kept />
    </>
  )
}
