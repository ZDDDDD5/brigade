// Who is using the computer: one teammate turn at a time, which the person can stop. The same
// rules as Brigade Computer Use on a Mac (apps/computer-use-macos main.swift).

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const STOPPED_MESSAGE =
  "The person pressed Stop on the computer-use indicator. Don't use the computer again in this turn: say so, and wait for their next message."

type Pill = { show: (text: string) => void; hide: () => void }

export class Sessions {
  private active: { id: string; label: string; last: number } | undefined
  private readonly stopped = new Set<string>()
  /** Turns the runner ended (the person interrupted the teammate): their command stops. */
  private readonly cancelled = new Set<string>()

  constructor(
    private readonly pill: Pill,
    private readonly now = () => Date.now(),
  ) {}

  /** Before each action: refuses a stopped turn, or another turn while one is acting. */
  begin(session: unknown) {
    const { id, label } = (session ?? {}) as { id?: unknown; label?: unknown }
    if (typeof id !== 'string' || !id)
      throw new HelperError('invalid_request', 'session.id is required')
    const name = typeof label === 'string' && label ? label : 'A Brigade teammate'
    if (this.stopped.has(id)) throw new HelperError('stopped', STOPPED_MESSAGE)
    const current = this.active
    if (current && current.id !== id && this.now() - current.last < 15_000)
      throw new HelperError(
        'busy',
        `${current.label} is using this computer right now. Try again in a moment.`,
      )
    this.active = { id, label: name, last: this.now() }
    this.pill.show(`${name} is using your computer`)
    return id
  }

  /** While a command runs: keeps its turn the one using the computer, and the pill up. False
   * once the person pressed Stop or the runner cancelled the turn: the command stops. */
  hold(id: string) {
    const current = this.active
    if (!current || current.id !== id || this.stopped.has(id) || this.cancelled.has(id))
      return false
    current.last = this.now()
    this.pill.show(`${current.label} is using your computer`)
    return true
  }

  /** The runner ended this turn: its command stops, and the pill goes. */
  cancel(id: string) {
    this.cancelled.add(id)
    if (this.active?.id === id) {
      this.active = undefined
      this.pill.hide()
    }
  }

  /** The person pressed Stop. */
  stop() {
    if (this.active) this.stopped.add(this.active.id)
    this.active = undefined
    this.pill.hide()
  }

  /** Whether a turn may still act (between the steps of a long action). */
  isStopped(id: string) {
    return this.stopped.has(id) || this.cancelled.has(id)
  }
}
