'use client'
import { useEffect, useRef, useState } from 'react'
import { DEMO_URL, FOCUS_ASK, FOCUS_SAY } from '@/lib/demo/flag'
import type { Story } from '@/lib/demo/tour'
import { c } from './parts'

// Wide enough for the dashboard's own layout, sidebar and all: narrower, the picture and a
// link to open the demo on its own.
const WIDE = '(min-width: 900px)'

// The walkthroughs a visitor picks from, the window's tabs (lib/demo/tour.ts plays each one).
// `short` where the window is too narrow for every label: the bar holds them all from 900px.
const STORIES: { id: Story; label: string; short: string }[] = [
  { id: 'bug', label: 'Fix a customer’s bug', short: 'Fix a bug' },
  { id: 'feature', label: 'Ship a requested feature', short: 'Ship a feature' },
  { id: 'call', label: 'Prep a sales call', short: 'Prep a call' },
  { id: 'payment', label: 'Chase a failed payment', short: 'Chase a payment' },
  { id: 'list', label: 'Work through a list', short: 'Work a list' },
]

/**
 * The live demo (demo.brigade.lol, docs/demo.md) under the hero: the real dashboard on a
 * sample workspace, running in a window on the page as soon as it opens, playing the story
 * picked in its tabs; on a phone, in its phone layout, in a phone. Its picture shows while it
 * loads.
 */
export function LiveDemo() {
  // Unknown until the page runs: the demo loads once it is known, so a wide screen never
  // loads the phone layout first.
  const [wide, setWide] = useState<boolean | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [story, setStory] = useState<Story>('bug')
  const view = useRef<HTMLDivElement>(null)
  useFocusSignal(view)
  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const update = () => setWide(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return (
    <section id="demo" aria-label="Live demo" className={c('live-demo')}>
      <div className={c('wrap')}>
        <div className={c('demo-win')}>
          <div className={c('demo-bar')}>
            <i></i>
            <i></i>
            <i></i>
            {wide ? (
              // The stories are the window's tabs, as in a browser: picking one loads it.
              <div className={c('demo-tabs')} role="tablist" aria-label="Stories to watch">
                {STORIES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="tab"
                    aria-selected={story === s.id}
                    className={c('demo-tab')}
                    onClick={() => {
                      if (story === s.id) return
                      setLoaded(false)
                      setStory(s.id)
                    }}
                  >
                    <span className={c('demo-tab-long')}>{s.label}</span>
                    <span className={c('demo-tab-short')}>{s.short}</span>
                  </button>
                ))}
              </div>
            ) : (
              <span className={c('demo-url mono')}>
                <span className={c('dot ok')}></span>demo.brigade.lol
              </span>
            )}
          </div>
          <div ref={view} className={c('demo-view')}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={c('demo-shot light-only')} src="/landing/demo-light.webp" alt="" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={c('demo-shot dark-only')} src="/landing/demo-dark.webp" alt="" />
            {wide !== null && (
              <iframe
                // ?tour=<story>: a cursor walks through a job on its own until the visitor takes
                // over (lib/demo/tour.ts), in the dashboard's phone layout on a phone, where there
                // are no tabs and it plays the first story. Another story loads the demo afresh.
                key={story}
                src={`${DEMO_URL}/app?tour=${story}`}
                title="Brigade demo workspace: click around, nothing here is real"
                allow="clipboard-write"
                className={c(loaded ? 'shown' : '')}
                onLoad={() => setLoaded(true)}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * Tells the demo in the frame when its window is ready to watch: the scroll brings it up
 * from faded to full (landing.module.css, .demo-win), and its walkthrough waits until it is
 * nearly full rather than playing half seen. That is at once without scroll-driven animations
 * or under reduced motion. It answers the frame's question, and says it again when that changes.
 */
function useFocusSignal(view: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const origin = new URL(DEMO_URL).origin
    let sharp = false
    const frame = () => view.current?.querySelector('iframe')?.contentWindow
    const say = () => frame()?.postMessage({ type: FOCUS_SAY, sharp }, origin)
    const check = () => {
      const win = view.current?.parentElement
      if (!win) return
      // Nearly full is enough: the visitor sees it, and waiting for the last of the fade
      // leaves the window sitting still in full view.
      const now = parseFloat(getComputedStyle(win).opacity) >= 0.85
      if (now === sharp) return
      sharp = now
      say()
    }
    const asked = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame()) return
      if ((e.data as { type?: string } | null)?.type === FOCUS_ASK) {
        check()
        say()
      }
    }
    let raf = 0
    const scrolled = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        check()
      })
    }
    check()
    window.addEventListener('message', asked)
    window.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('message', asked)
      window.removeEventListener('scroll', scrolled)
    }
  }, [view])
}
