// What computer use on Linux sends and where: points in screen points (a monitor's logical
// pixels, the top-left of the layout's origin at 0,0), the units of the screenshots.

export type Point = { x: number; y: number }

export type Monitor = {
  /** Electron's display id on X11, the connector (eDP-1) on GNOME Wayland. */
  id: string
  x: number
  y: number
  width: number
  height: number
  /** Pixels per point. */
  scale: number
  primary: boolean
}

/**
 * Between the steps of a long action (each character typed, each move of a drag, each click):
 * throws once the person pressed Stop or the turn was cancelled, after which what the action
 * holds (a button, modifiers, borrowed keys) is released and nothing more is sent.
 */
export type Check = () => void

/** The mouse and keyboard. */
export interface Input {
  move(p: Point): Promise<void>
  click(p: Point, button: string, count: number, modifiers: string[], check?: Check): Promise<void>
  drag(from: Point, to: Point, check?: Check): Promise<void>
  scroll(p: Point, direction: string, amount: number): Promise<void>
  type(text: string, check?: Check): Promise<void>
  key(combo: string): Promise<void>
  close(): void | Promise<void>
}

/** The kind of graphical session Brigade runs in: Wayland wins when both are reachable. */
export function sessionType(env = process.env): 'x11' | 'wayland' | undefined {
  if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland') return 'wayland'
  if (env.DISPLAY) return 'x11'
  return undefined
}

/** The monitor a point is on. */
export function monitorAt(monitors: Monitor[], p: Point) {
  return monitors.find(
    (m) => p.x >= m.x && p.x < m.x + m.width && p.y >= m.y && p.y < m.y + m.height,
  )
}

/**
 * Where a monitor is in a screenshot of the whole desktop (Wayland's portal takes only that),
 * in the image's pixels: the image spans the layout's bounding box, at `ratio` pixels a point.
 */
export function cropOf(monitors: Monitor[], monitor: Monitor, imageWidth: number) {
  const minX = Math.min(...monitors.map((m) => m.x))
  const minY = Math.min(...monitors.map((m) => m.y))
  const maxX = Math.max(...monitors.map((m) => m.x + m.width))
  const ratio = imageWidth / (maxX - minX)
  return {
    x: Math.round((monitor.x - minX) * ratio),
    y: Math.round((monitor.y - minY) * ratio),
    width: Math.round(monitor.width * ratio),
    height: Math.round(monitor.height * ratio),
  }
}
