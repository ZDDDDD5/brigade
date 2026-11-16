// Moving an element of a design's page by hand: dragged on the canvas, or nudged
// with the arrow keys. A move is the element's own `translate` (the CSS property,
// apart from `transform`, so it adds to what the page already does with it, an
// animation included), written inline into the page like any other style.

/** A computed or written `translate` split into its axes ("none" is no move). */
export function translateAxes(value: string | undefined | null): string[] {
  const text = (value ?? '').trim()
  if (!text || text === 'none') return ['0px', '0px']
  // Split on spaces outside parentheses: `calc(50% + 4px) 0px` is two axes.
  const axes: string[] = []
  let depth = 0
  let current = ''
  for (const c of text) {
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    if (/\s/.test(c) && depth === 0) {
      if (current) axes.push(current)
      current = ''
    } else current += c
  }
  if (current) axes.push(current)
  // One value moves along x only.
  if (axes.length === 1) axes.push('0px')
  return axes.slice(0, 3)
}

const PX = /^(-?\d+(?:\.\d+)?)px$/
const round = (n: number) => Math.round(n * 100) / 100

/** An axis moved by `by` px: a px value stays one, anything else (a percentage) becomes calc(). */
function shift(axis: string, by: number) {
  if (axis === '0') axis = '0px'
  const px = PX.exec(axis)
  if (px) return `${round(Number(px[1]) + by)}px`
  if (by === 0) return axis
  const inner = axis.startsWith('calc(') && axis.endsWith(')') ? axis.slice(5, -1) : axis
  return `calc(${inner} ${by < 0 ? '-' : '+'} ${round(Math.abs(by))}px)`
}

/** The `translate` of an element that was at `from` and moved by (dx, dy) px of its page. */
export function movedTranslate(from: string | undefined | null, dx: number, dy: number): string {
  const [x = '0px', y = '0px', z] = translateAxes(from)
  const moved = [shift(x, Math.round(dx)), shift(y, Math.round(dy))]
  if (z && z !== '0px' && z !== '0') moved.push(z)
  return moved.join(' ')
}
