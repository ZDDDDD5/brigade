'use client'

import { useEffect, useRef } from 'react'
import { c } from './parts'

const SHAPE = 'M56 0A44 56 0 0 1 100 56A40 44 0 0 1 60 100A60 54 0 0 1 0 46A56 46 0 0 1 56 0Z'

// The dancers, left to right: colour, eyes and size (in the title's em).
const DANCERS: { fill: string; smile?: boolean; size: number }[] = [
  { fill: 'oklch(0.78 0.16 155)', smile: true, size: 0.66 },
  { fill: 'oklch(0.74 0.17 50)', size: 0.6 },
  { fill: 'oklch(0.62 0.22 290)', size: 0.7 },
  { fill: 'oklch(0.87 0.14 90)', smile: true, size: 0.58 },
  { fill: 'oklch(0.72 0.13 250)', size: 0.64 },
  { fill: 'oklch(0.8 0.08 20)', smile: true, size: 0.6 },
]

// In the title's em and seconds.
const GRAVITY = 34
// How far apart their spots are, as a share of their widths: about 1, they touch.
const PACK = 1
// Each one's body, for bumping into the others: a circle in its box (share of its width).
const BODY = { x: 0.5, y: 0.52, r: 0.49 }
// When each lets go, in the order they fall (seconds after the font is in): one alone, a
// beat, three nearly together, one more, and a last one late, which lands on a neighbour.
const BEATS = [0.35, 1.05, 1.13, 1.2, 1.55, 2.3]
// The letters under them: a spring each, pressed down by a landing (em per second at the
// hardest landing), so the word takes their weight.
const LETTER = { k: 320, damp: 13, kick: 1.1, spread: 0.35 }

/** Its face: its own eyes, round in the fall, squeezed on impact, smiling once down. */
type Face = 'open' | 'o' | 'squeeze' | 'joy'

type Dancer = {
  home: number
  x: number
  y: number
  vx: number
  vy: number
  size: number
  // Squash (positive is flatter) and its speed, a damped spring.
  q: number
  qv: number
  lean: number
  grounded: boolean
  next: number
  // Seconds until it pops out of the word, on the way in; 0 once out.
  wait: number
  // Whether it has landed once, and until when (the clock, seconds) its face reacts.
  landed: boolean
  squeeze: number
  joy: number
  face: Face
  // A hop it was told to make (the bow once all are down), in px; 0 for none.
  hop: number
}

const random = (min: number, max: number) => min + Math.random() * (max - min)

/**
 * Pebbles dancing on "AI teammates", side by side, each standing on the letters under it:
 * its own outline against the glyphs' tops, measured from the font, so one sits lower on an
 * "e" than on a "t" and always touches. Each jumps on its own at random, small hops mostly
 * and a bigger one now and then, falls back under gravity, squashes on landing and springs
 * back, and leans as it moves. They bump into each other and never overlap; one off its spot
 * hops back to it, never slides. When the page opens, they rain down one at a time from above
 * the page and land on the letters. They sit behind the word's ink, so they never cover it.
 * It runs only while the title shows; under reduced motion they stand still on the letters.
 */
export function Dancers({ word: label }: { word: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const lettersRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const box = ref.current
    const word = box?.parentElement
    const letters = lettersRef.current
    if (!box || !word || !letters) return
    const els = [...box.children] as HTMLElement[]
    const glyphs = [...letters.children] as HTMLElement[]
    // Each letter's dip (px, down) and its speed, and which letter each px column is in.
    const dip = new Float32Array(glyphs.length)
    const dipV = new Float32Array(glyphs.length)
    const shown = new Float32Array(glyphs.length)
    let letterAt = new Int16Array(0)
    let clock = 0
    // The bow: once all are down and on their spots, they hop together once.
    let bowed = false
    let calm = 0
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let em = 1
    // The letters' outline seen from above: for each px column from `start`, in px from the
    // box's top, the highest ink of the word there (Infinity between letters).
    let start = 0
    let tops = new Float32Array(0)
    let dancers: Dancer[] = []
    // Those that have fallen already, and whether the font has loaded: until then the
    // letters' outline is not final, so none falls yet.
    const fallen = new Set<number>()
    let fontReady = false

    // Draws the word in a canvas with the title's font and reads, column by column, where
    // its ink starts: the true outline of each glyph, the t's cross and the a's curve
    // included, placed on the page's baseline (where the zero-height probe sits).
    const measure = () => {
      const probe = word.querySelector<HTMLElement>('[data-baseline]')
      const chars = letters.textContent ?? ''
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
      if (!probe || !ctx || !chars) return
      const style = getComputedStyle(word)
      em = parseFloat(style.fontSize)
      const range = document.createRange()
      range.selectNodeContents(letters)
      const rect = range.getBoundingClientRect()
      const origin = box.getBoundingClientRect()
      const baseline = probe.getBoundingClientRect().top - origin.top
      const scale = 2
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      ctx.font = font
      if (style.letterSpacing !== 'normal') ctx.letterSpacing = style.letterSpacing
      const width = Math.ceil(ctx.measureText(chars).width)
      // Fit the drawing to the page's own width, in case spacing differs a hair.
      const sx = width ? rect.width / width : 1
      const canvas = ctx.canvas
      canvas.width = Math.ceil(rect.width * scale) + 4
      canvas.height = Math.ceil(em * 1.6 * scale)
      ctx.font = font
      if (style.letterSpacing !== 'normal') ctx.letterSpacing = style.letterSpacing
      ctx.setTransform(scale * sx, 0, 0, scale, 0, 0)
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(chars, 0, em * 1.3)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      start = rect.left - origin.left
      tops = new Float32Array(Math.ceil(rect.width)).fill(Infinity)
      // Which letter each column is in, the nearest one between them.
      letterAt = new Int16Array(tops.length).fill(-1)
      glyphs.forEach((g, i) => {
        const r = g.getBoundingClientRect()
        const from = Math.max(0, Math.floor(r.left - origin.left - start))
        const to = Math.min(tops.length - 1, Math.ceil(r.right - origin.left - start))
        for (let col = from; col <= to; col++) letterAt[col] = i
      })
      for (let col = 0; col < tops.length; col++) {
        // The highest ink across this page pixel's two canvas columns.
        for (let row = 0; row < canvas.height; row++) {
          const i = (row * canvas.width + col * scale) * 4 + 3
          if (data[i]! > 110 || data[i + 4]! > 110) {
            tops[col] = baseline - (em * 1.3 - row / scale)
            break
          }
        }
      }
    }

    // The pebble's underside: for each of SLICES slices across its box, how low its outline
    // goes (share of its width), read from the drawn shape itself.
    const SLICES = 48
    const under = new Array<number>(SLICES + 1).fill(-1)
    const outline = els[0]?.querySelector('path')
    if (outline) {
      const length = outline.getTotalLength()
      for (let k = 0; k <= 800; k++) {
        const p = outline.getPointAtLength((k / 800) * length)
        const slice = Math.round((p.x / 100) * SLICES)
        under[slice] = Math.max(under[slice]!, p.y / 100)
      }
    }

    // Where a pebble of width w at x (its box's left) comes to rest on the letters: the box
    // top at which its underside first touches the word's ink, column by column. Over no
    // letter at all, it rests on the lowest of them.
    const rest = (x: number, w: number) => {
      let top = Infinity
      const from = Math.max(0, Math.floor(x - start))
      const to = Math.min(tops.length - 1, Math.ceil(x + w - start))
      for (let col = from; col <= to; col++) {
        const ink = tops[col]! + (dip[letterAt[col]!] ?? 0)
        if (ink === Infinity) continue
        const u = under[Math.round(((col + start - x) / w) * SLICES)]
        if (u === undefined || u < 0) continue
        top = Math.min(top, ink - u * w)
      }
      if (top !== Infinity) return top
      let lowest = -Infinity
      for (const ink of tops) if (ink !== Infinity) lowest = Math.max(lowest, ink)
      return lowest - w
    }

    const place = () => {
      measure()
      if (!tops.length) return
      const end = start + tops.length
      const widths = DANCERS.map((d) => d.size * em)
      const row = widths.reduce((sum, w) => sum + w * PACK, 0)
      let x = start + (end - start - row) / 2
      // How far the word sits from the top of the page, to drop them from above it.
      const top = box.getBoundingClientRect().top + window.scrollY
      // On the way in, they fall one at a time, in a shuffled order. Measuring again (the
      // font loading, the frame resizing) lands those already down on their spot and lets
      // the others still fall.
      const order = DANCERS.map((_, i) => i)
        .filter((i) => !still && !fallen.has(i))
        .sort(() => Math.random() - 0.5)
      dancers = DANCERS.map((d, i) => {
        const w = widths[i]!
        const home = x
        x += w * PACK
        els[i]!.style.width = `${w}px`
        const turn = order.indexOf(i)
        const wait = turn < 0 ? 0 : fontReady ? BEATS[turn]! + random(0, 0.04) : Infinity
        els[i]!.style.opacity = wait ? '0' : '1'
        // The late one comes down a little to one side, onto a neighbour's shoulder.
        const late = turn === DANCERS.length - 1
        const side = i === 0 ? 1 : i === DANCERS.length - 1 ? -1 : Math.random() < 0.5 ? -1 : 1
        return {
          home,
          x: late ? home + side * 0.42 * w : home,
          // Waiting, it is above the top of the page, out of sight.
          y: wait ? -(top + w * 1.5) : rest(home, w),
          vx: 0,
          vy: 0,
          size: w,
          q: 0,
          qv: 0,
          lean: 0,
          grounded: !wait,
          next: random(0.6, 2),
          wait,
          landed: !wait,
          squeeze: 0,
          joy: 0,
          face: 'open' as Face,
          hop: 0,
        }
      })
    }

    const draw = () => {
      dancers.forEach((d, i) => {
        const el = els[i]
        if (!el) return
        // Fast through the air it stretches along its fall, thinner and taller; squash keeps
        // the feet down: it scales from the bottom.
        const speed = d.grounded ? 0 : Math.hypot(d.vx, d.vy) / em
        const st = Math.min(speed * 0.009, 0.2)
        el.style.transform = `translate(${d.x}px, ${d.y}px) rotate(${d.lean}rad) scale(${1 + d.q - st * 0.5}, ${1 - d.q + st})`
        const face: Face =
          d.wait > 0 || still
            ? 'open'
            : !d.landed
              ? 'o'
              : clock < d.squeeze
                ? 'squeeze'
                : clock < d.joy
                  ? 'joy'
                  : 'open'
        if (face !== d.face) {
          d.face = face
          el.dataset.face = face
        }
      })
      glyphs.forEach((g, i) => {
        if (Math.abs(dip[i]! - shown[i]!) < 0.05) return
        shown[i] = dip[i]!
        g.style.top = `${dip[i]!.toFixed(2)}px`
      })
    }

    // A landing (or a push off) at x, as hard as `impact` (em per second): the letter under it
    // dips, its neighbours a little.
    const press = (x: number, impact: number) => {
      if (still || !letterAt.length) return
      const col = Math.max(0, Math.min(letterAt.length - 1, Math.round(x - start)))
      const at = letterAt[col]!
      if (at < 0) return
      const v = (Math.min(impact, 14) / 14) * LETTER.kick * em
      dipV[at] = dipV[at]! + v
      if (at > 0) dipV[at - 1] = dipV[at - 1]! + v * LETTER.spread
      if (at < glyphs.length - 1) dipV[at + 1] = dipV[at + 1]! + v * LETTER.spread
    }

    const step = (dt: number) => {
      const g = GRAVITY * em
      clock += dt
      for (let i = 0; i < glyphs.length; i++) {
        dipV[i] = dipV[i]! + (-LETTER.k * dip[i]! - LETTER.damp * dipV[i]!) * dt
        dip[i] = dip[i]! + dipV[i]! * dt
      }
      for (const [i, d] of dancers.entries()) {
        if (d.wait > 0) {
          d.wait -= dt
          if (d.wait > 0) continue
          // Its turn: it lets go and falls, drifting a hair to one side; gravity and the
          // landing do the rest.
          d.wait = 0
          d.landed = false
          fallen.add(i)
          d.vy = 0
          d.vx = random(-1, 1) * 0.1 * em
          d.grounded = false
          const el = els[i]
          if (el) el.style.opacity = '1'
          continue
        }
        d.next -= dt
        // Off its spot (a bounce or a neighbour moved it), it hops back soon rather than slide.
        const away = d.home - d.x
        if (d.grounded && Math.abs(away) > 0.06 * em) d.next = Math.min(d.next, random(0.12, 0.35))
        // Until the bow, one on its spot waits for the others: only hopping back is allowed.
        const off = Math.abs(away) > 0.06 * em
        if (d.grounded && d.next <= 0 && (bowed || d.hop > 0 || off)) {
          // Mostly small hops, a bigger one now and then. Each one aims to land near its
          // spot: back onto it when it is off, a little to either side when it is on it.
          const h = d.hop || (Math.random() < 0.2 ? random(0.35, 0.6) : random(0.08, 0.25)) * em
          d.vy = -Math.sqrt(2 * g * h)
          const air = (2 * -d.vy) / g
          const target = off || d.hop ? away : random(-1, 1) * 0.12 * em
          d.vx = target / air
          d.grounded = false
          // A push off the ground stretches it a little, and presses the letter under it.
          d.qv -= d.hop ? 3 : 2
          press(d.x + d.size / 2, (-d.vy / em) * 0.5)
          if (d.hop) d.joy = clock + 1.4
          d.hop = 0
          d.next = random(0.3, 2.4)
        }
        if (!d.grounded) {
          d.vy += g * dt
          d.x += d.vx * dt
          d.y += d.vy * dt
          const floor = rest(d.x, d.size)
          if (d.y >= floor && d.vy > 0) {
            d.y = floor
            const impact = d.vy / em
            press(d.x + d.size / 2, impact)
            // Its first landing: eyes squeezed on the impact, then a smile.
            if (!d.landed) {
              d.landed = true
              d.squeeze = clock + 0.17
              d.joy = clock + 1
            } else if (impact > 6) d.squeeze = clock + 0.1
            // A light bounce off the letter, a smaller one after it until it settles, and a
            // squash as hard as the landing.
            d.vy = impact > 1.5 ? -d.vy * 0.28 : 0
            d.grounded = d.vy === 0
            d.qv += Math.min(impact, 12) * 0.5
            d.vx *= 0.4
          }
        } else {
          // Standing: it stays put on the letters under it; it only moves by hopping.
          d.vx = 0
          d.y = rest(d.x, d.size)
        }
        // The squash spring, and the lean following the sideways speed.
        d.qv += (-260 * d.q - 12 * d.qv) * dt
        d.q = Math.max(-0.1, Math.min(0.26, d.q + d.qv * dt))
        d.lean += ((d.vx / em) * 0.1 - d.lean) * Math.min(1, 10 * dt)
      }
      // They never pass through each other: two bodies that overlap are pushed apart along
      // the line between them and bounce off it. One standing only moves sideways (the
      // letters hold it up); one in the air takes the rest.
      for (let i = 0; i < dancers.length; i++) {
        for (let j = i + 1; j < dancers.length; j++) {
          const a = dancers[i]!
          const b = dancers[j]!
          if (a.wait > 0 || b.wait > 0) continue
          const ax = a.x + BODY.x * a.size
          const ay = a.y + BODY.y * a.size
          const bx = b.x + BODY.x * b.size
          const by = b.y + BODY.y * b.size
          const dx = bx - ax
          const dy = by - ay
          const dist = Math.hypot(dx, dy)
          const min = BODY.r * (a.size + b.size)
          if (dist === 0 || dist >= min) continue
          const nx = dx / dist
          const ny = dy / dist
          const push = min - dist
          const share = a.grounded === b.grounded ? 0.5 : a.grounded ? 0 : 1
          a.x -= nx * push * share
          b.x += nx * push * (1 - share)
          if (!a.grounded) a.y -= ny * push * share
          if (!b.grounded) b.y += ny * push * (1 - share)
          // Sideways, a standing one still gives way a little.
          if (a.grounded && b.grounded) continue
          if (a.grounded) a.x -= nx * push * 0.3
          if (b.grounded) b.x += nx * push * 0.3
          const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
          if (vn >= 0) continue
          const jn = -1.3 * vn
          if (!a.grounded) {
            a.vx -= jn * nx * share
            a.vy -= jn * ny * share
          }
          if (!b.grounded) {
            b.vx += jn * nx * (1 - share)
            b.vy += jn * ny * (1 - share)
          }
        }
      }
      // All down and on their spots for a moment: they bow, a hop together, a hair apart.
      if (
        !bowed &&
        !still &&
        fallen.size === dancers.length &&
        dancers.every((d) => d.grounded && Math.abs(d.home - d.x) < 0.06 * em)
      ) {
        calm += dt
        if (calm > 0.35) {
          bowed = true
          dancers.forEach((d, i) => {
            d.hop = 0.42 * em
            d.next = i * 0.05
          })
        }
      } else calm = 0
      // Nothing ends up below the letters: a push from a neighbour can't sink one into them.
      for (const d of dancers) {
        if (d.wait > 0) continue
        const floor = rest(d.x, d.size)
        if (d.grounded || d.y > floor) d.y = floor
      }
    }

    let frame = 0
    let last = 0
    let visible = false
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30)
      last = now
      // A few small steps a frame keep landings exact.
      for (let k = 0; k < 4; k++) step(dt / 4)
      draw()
      frame = requestAnimationFrame(tick)
    }
    const run = () => {
      if (still || !visible || frame) return
      last = performance.now()
      frame = requestAnimationFrame(tick)
    }
    const stop = () => {
      cancelAnimationFrame(frame)
      frame = 0
    }

    const setup = () => {
      place()
      draw()
      box.setAttribute('data-ready', '')
    }
    setup()
    // The glyphs' tops depend on the font: measure again once it has loaded.
    void document.fonts.ready.then(() => {
      fontReady = true
      setup()
    })
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      if (visible) run()
      else stop()
    })
    observer.observe(word)
    // The word changing size (the title's font swapping in, the window or frame resizing)
    // moves its letters: measure them again, so nobody floats or sinks into them.
    let size = ''
    const resized = new ResizeObserver(([entry]) => {
      const next = `${entry?.contentRect.width}x${entry?.contentRect.height}`
      if (next === size) return
      const first = !size
      size = next
      if (!first) setup()
    })
    resized.observe(word)
    return () => {
      stop()
      observer.disconnect()
      resized.disconnect()
    }
  }, [])

  return (
    <>
      {/* A span a letter, so each can dip under a landing; they read as the one word. */}
      <span ref={lettersRef}>
        {[...label].map((ch, i) => (
          <span key={i} className={c('dn-l')}>
            {ch}
          </span>
        ))}
      </span>
      {/* Zero-height, on the baseline: where the letters stand, for measuring them. */}
      <span className={c('dn-base')} data-baseline aria-hidden="true" />
      <span ref={ref} className={c('dancers')} aria-hidden="true">
        {DANCERS.map((d, i) => (
          <span key={i} className={c('dancer')} data-face="open">
            <svg viewBox="0 0 100 100">
              <path d={SHAPE} fill={d.fill} />
              <g className={c('dn-o')}>
                <ellipse className={c('dn-eye')} cx="40.5" cy="40" rx="4" ry="5.5" />
                <ellipse className={c('dn-eye')} cx="59.5" cy="40" rx="4" ry="5.5" />
              </g>
              <path className={c('dn-eye dn-sq')} d="M35 35L45 40.5L35 46M65 35L55 40.5L65 46" />
              <path
                className={c('dn-eye dn-joy')}
                d="M34.5 44Q40.5 28 46.5 44M53.5 44Q59.5 28 65.5 44"
              />
              <g
                className={c('dn-blink dn-open')}
                style={{ animationDuration: `${3.3 + i * 0.7}s` }}
              >
                <path
                  className={c('dn-eye')}
                  d={
                    d.smile
                      ? 'M34.5 44Q40.5 28 46.5 44M53.5 44Q59.5 28 65.5 44'
                      : 'M40.5 34V45M59.5 34V45'
                  }
                />
              </g>
            </svg>
          </span>
        ))}
      </span>
    </>
  )
}
