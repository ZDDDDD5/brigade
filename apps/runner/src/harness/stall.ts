// A turn whose harness stream went quiet with nothing running: the model's response stopped
// coming, and nothing will end it. On 2026-11-22 a member's Mac slept mid-response: Claude
// Code's request to the model never came back, the thread stayed running with no event for
// 2 h 20 min, and only Claude Code's own error ended it. On 2026-11-17 a Codex turn resumed
// with a ticket's answer sent nothing at all for 75 minutes, until the person stopped it.
//
// The runner hears every part of the stream; while a tool call is open (a command, a sub-agent,
// a ticket or question waiting on a person), an approval is asked, or the turn waits on work in
// the background (staleWait in index.ts), quiet is expected and not counted. Otherwise, once
// nothing came for STALL_MS, the turn's stream is stopped and the turn fails with an error the
// thread shows.
//
// Counted on the monotonic clock (performance.now), which stands still while the computer
// sleeps on macOS and Linux: a computer asleep for the night does not stall a turn by sleeping
// alone; once awake, the harness has STALL_MS to go on.

/** Quiet this long, with nothing running, and the turn's stream is stuck. */
export const STALL_MS = Number(process.env.BRIGADE_STALL_MS) || 20 * 60_000
/** How often a turn's stream is looked at. */
const CHECK_MS = () => Math.min(STALL_MS, 30_000)

export const stalledMessage = (ms = STALL_MS) =>
  `Nothing came from the model for ${Math.round(ms / 60_000) || 1} min while nothing else ran ` +
  '(its connection may have broken, or the computer slept mid-response), so the turn was stopped. ' +
  'Send a message to go on.'

export type StallWatchOptions = {
  /** Whether quiet is expected now: a tool call open, an approval asked, background work. */
  busy: () => boolean
  /** The stream is stuck: stop it. Called once. */
  onStall: (message: string) => void
  /** The monotonic clock, in ms (tests give their own). */
  now?: () => number
  quietMs?: number
}

/** Watches one turn's streams: `streaming` while one is read, `heard` at each of its parts. */
export class StallWatch {
  private last: number
  private reading = 0
  private timer: NodeJS.Timeout | undefined
  /** The error the turn fails with, once stalled. */
  stalled: string | undefined
  private readonly now: () => number
  private readonly quietMs: number

  constructor(private readonly options: StallWatchOptions) {
    this.now = options.now ?? (() => performance.now())
    this.quietMs = options.quietMs ?? STALL_MS
    this.last = this.now()
  }

  /** Something came from the harness, or what kept it busy ended: quiet counts from now. */
  heard() {
    this.last = this.now()
  }

  /** A stream of the turn is being read from now until the returned function is called. */
  streaming() {
    this.reading++
    this.heard()
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), Math.min(this.quietMs, CHECK_MS()))
      this.timer.unref?.()
    }
    let done = false
    return () => {
      if (done) return
      done = true
      this.reading--
      if (this.reading === 0) this.stop()
    }
  }

  /** Looked at now: stalls the turn if its stream has been quiet too long with nothing running. */
  check() {
    if (this.stalled || this.reading === 0) return
    // Busy, quiet is expected: counted again from when it no longer is.
    if (this.options.busy()) return this.heard()
    const quiet = this.now() - this.last
    if (quiet < this.quietMs) return
    this.stalled = stalledMessage(this.quietMs)
    this.stop()
    this.options.onStall(this.stalled)
  }

  stop() {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
