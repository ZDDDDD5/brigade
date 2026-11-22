'use client'
import { MousePointer2, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DEMO, FOCUS_ASK, FOCUS_SAY, framed } from '@/lib/demo/flag'
import { keepFrameStill, play, Stopped, storyOf, TOUR_PARAM } from '@/lib/demo/tour'

/**
 * The demo's walkthrough (lib/demo/tour.ts), on demo.brigade.lol/app?tour: the landing page's
 * frame opens it. It starts once the frame is in view, stops at the visitor's first click, key
 * or scroll, and then offers to play it again.
 */
export function DemoTour() {
  const cursor = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'off' | 'waiting' | 'playing' | 'yours'>('off')

  useEffect(() => {
    if (!DEMO || !new URLSearchParams(location.search).has(TOUR_PARAM)) return
    const story = storyOf(new URLSearchParams(location.search).get(TOUR_PARAM))
    setState('waiting')
    const abort = new AbortController()
    // A press, a tap or a key: never a scroll. Scrolling the landing page with the pointer over
    // the frame sends its wheel (or a finger's touch) here, and the visitor only meant to scroll.
    const kinds = ['pointerdown', 'click', 'keydown']
    let observer: IntersectionObserver | undefined
    let restore: (() => void) | undefined
    // However it ends (the visitor, the walkthrough done, the page left): nothing of it stays.
    const end = () => {
      observer?.disconnect()
      restore?.()
      restore = undefined
      for (const kind of kinds) window.removeEventListener(kind, takeOver, { capture: true })
    }
    // A person's own input ends it, also before it started: events the tour makes are not trusted.
    const takeOver = (e: Event) => {
      if (!e.isTrusted || abort.signal.aborted) return
      // A finger down may start a scroll: only its tap (a click) takes over.
      if (e.type === 'pointerdown' && (e as PointerEvent).pointerType === 'touch') return
      abort.abort()
      end()
      setState((was) => (was === 'waiting' ? 'off' : 'yours'))
    }
    for (const kind of kinds)
      window.addEventListener(kind, takeOver, { capture: true, passive: true })

    // In the landing's frame, the screen comes into focus as the visitor scrolls: it plays
    // once both in view and in focus. A landing that never answers (an older one) does not
    // hold it back.
    let inView = false
    let sharp = true
    let held = false
    let started = false
    const heard = (e: MessageEvent) => {
      if (e.source !== window.parent) return
      const data = e.data as { type?: string; sharp?: boolean } | null
      if (data?.type !== FOCUS_SAY) return
      held = true
      sharp = Boolean(data.sharp)
      if (inView && sharp) start()
    }
    if (framed()) {
      sharp = false
      window.addEventListener('message', heard)
      window.parent.postMessage({ type: FOCUS_ASK }, '*')
      window.setTimeout(() => {
        if (held) return
        sharp = true
        if (inView) start()
      }, 1500)
    }
    const stopListening = () => window.removeEventListener('message', heard)

    const start = () => {
      if (started || abort.signal.aborted || !cursor.current || !inView || !sharp) return
      started = true
      observer?.disconnect()
      stopListening()
      // The merge asks to confirm: the tour says yes, only while it plays.
      const confirm = window.confirm
      window.confirm = () => true
      const still = keepFrameStill()
      restore = () => {
        window.confirm = confirm
        still()
      }
      setState('playing')
      play({ signal: abort.signal, cursor: cursor.current }, story)
        .catch((e) => {
          if (!(e instanceof Stopped)) console.error(e)
        })
        .finally(() => {
          end()
          setState('yours')
        })
    }
    // In the landing page's frame, once most of it shows (the frame's view is the page's).
    observer = new IntersectionObserver(
      (entries) => {
        inView = entries.some((e) => e.intersectionRatio >= 0.35)
        start()
      },
      { threshold: [0, 0.35, 0.6] },
    )
    observer.observe(document.documentElement)
    return () => {
      abort.abort()
      end()
      stopListening()
    }
  }, [])

  if (state === 'off') return null
  return (
    <>
      <div
        ref={cursor}
        hidden={state !== 'playing'}
        aria-hidden
        className="pointer-events-none fixed top-0 left-0 z-[2147483647] transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] data-[pressed]:scale-90 motion-reduce:transition-none"
        style={{ transform: 'translate(55vw, 60vh)' }}
      >
        <MousePointer2 className="fill-primary text-primary-foreground size-6 -translate-x-1 -translate-y-1 drop-shadow-md" />
        <span className="bg-primary text-primary-foreground ml-4 rounded-full px-2 py-0.5 text-xs font-semibold shadow-md">
          You
        </span>
      </div>
      {state === 'yours' && (
        // White, lifted by its shadow; above the message box, not over its send button.
        <div className="fixed right-4 bottom-24 z-50 flex items-center gap-2 rounded-full bg-white py-1.5 pr-1.5 pl-4 text-sm text-neutral-950 shadow-lg ring-1 ring-black/5">
          <span className="font-semibold">Your turn</span>
          <span className="text-neutral-500">click around</span>
          <button
            type="button"
            // From the start, Home: a reload anywhere else would replay from where it ended.
            onClick={() =>
              location.assign(
                `/app?${TOUR_PARAM}=${storyOf(new URLSearchParams(location.search).get(TOUR_PARAM))}`,
              )
            }
            className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-neutral-950 px-3 py-1 font-semibold text-white transition-colors hover:bg-neutral-800"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Replay
          </button>
        </div>
      )}
    </>
  )
}
