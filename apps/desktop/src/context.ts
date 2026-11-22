// What the app's parts share, filled in by main.ts as it starts.
import type { Helper } from './helper.js'
import type { LinuxComputerUse } from './linux/computer-use.js'
import type { Supervisor } from './runner.js'

export type Context = {
  supervisor: Supervisor
  helper: Helper
  /** Linux: computer use, served by Brigade.app itself. */
  linux?: LinuxComputerUse
  /** Builds the menu-bar menu again from the current state. */
  refreshMenu: () => void
  /** Quit or an update's restart is under way: windows close for good, and the runner stops. */
  quitting: boolean
}

export const ctx = {} as Context
