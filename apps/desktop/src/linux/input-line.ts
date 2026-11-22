// The mouse and keyboard, one action at a time across every connection: the runner opens a
// socket per request, and two clicks sent in parallel once both landed on the second's point.
// An action waits for those before it, then runs only while its turn may still act: Stop or a
// cancel while it waited sends nothing, and the input checks it again right before each press,
// move or scroll it sends, after whatever it awaited to prepare it.
import type { Check, Input } from './input.js'
import { HelperError, STOPPED_MESSAGE, type Sessions } from './sessions.js'

export class InputLine {
  private last: Promise<void> = Promise.resolve()

  constructor(
    private readonly sessions: Pick<Sessions, 'isStopped'>,
    private readonly input: () => Promise<Input>,
  ) {}

  async run<T>(id: string, work: (input: Input, check: Check) => Promise<T>): Promise<T> {
    const check: Check = () => {
      if (this.sessions.isStopped(id)) throw new HelperError('stopped', STOPPED_MESSAGE)
    }
    const before = this.last
    let done!: () => void
    this.last = new Promise<void>((resolve) => (done = resolve))
    try {
      await before
      check()
      const input = await this.input()
      // Again after the input's start, and before each event it sends (Input.guard).
      check()
      input.guard = check
      try {
        return await work(input, check)
      } finally {
        input.guard = undefined
      }
    } finally {
      done()
    }
  }
}
