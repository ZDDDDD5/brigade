'use client'

import { useEffect } from 'react'

/** Pauses the looping animations of a section (marked `data-anim`) while it is off screen,
 * with one IntersectionObserver for the page. It only ever adds `data-offscreen`, so before
 * it runs, and without JavaScript, every section plays: nothing waits on it to appear. */
export function PauseOffscreen() {
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          entry.target.toggleAttribute('data-offscreen', !entry.isIntersecting)
      },
      { rootMargin: '200px 0px' },
    )
    for (const el of document.querySelectorAll('[data-anim]')) observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return null
}

// How far apart the parts of a group come in, and how long one takes, in ms.
const STAGGER = 80
const SETTLE = 1400

/**
 * Reveals the page as it is read: what is marked `data-reveal` and still below the fold when
 * the page opens waits hidden, and comes in once it scrolls into view, a single time
 * (globals.css: rise out of a blur; `pop` also grows a little). `stagger` brings in its
 * children one after another; `data-reveal-delay` holds one back that many beats. Nothing
 * on screen at the start is touched, so there is no flash; without JavaScript, or under
 * reduced motion, everything simply shows. Once in, the attribute goes, and with it every
 * style it set: the element's own transitions and hovers are back.
 */
export function Reveal() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const waiting = [...document.querySelectorAll<HTMLElement>('[data-reveal]')].filter(
      (el) => el.getBoundingClientRect().top > window.innerHeight * 0.92,
    )
    const parts = (el: HTMLElement) =>
      el.dataset.reveal === 'stagger' ? ([...el.children] as HTMLElement[]) : [el]
    for (const el of waiting) {
      const base = Number(el.dataset.revealDelay ?? 0)
      parts(el).forEach((part, i) => part.style.setProperty('--ri', String(base + i)))
      el.setAttribute('data-hidden', '')
    }
    const timers: number[] = []
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const el = entry.target as HTMLElement
          observer.unobserve(el)
          el.removeAttribute('data-hidden')
          const beats = Number(el.dataset.revealDelay ?? 0) + parts(el).length
          timers.push(
            window.setTimeout(
              () => {
                for (const part of parts(el)) part.style.removeProperty('--ri')
                el.removeAttribute('data-reveal')
              },
              beats * STAGGER + SETTLE,
            ),
          )
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    )
    for (const el of waiting) observer.observe(el)
    return () => {
      observer.disconnect()
      timers.forEach((t) => window.clearTimeout(t))
    }
  }, [])
  return null
}
