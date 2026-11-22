// Picking elements in a preview, as Claude does: the proxy adds a script to each
// page it serves, and the dashboard's preview panel turns its select mode on and
// off. While it is on, what the pointer is over is outlined; a click sends that
// element (where it is, its React components, its HTML) to the panel instead of
// reaching the page, and the panel puts it in the composer (contracts'
// preview-elements.ts). Esc in the page turns it off. Then the page draws the
// element (modern-screenshot, loaded only then from the proxy) and sends that
// picture too, for the message to carry as an image. It also tells the panel which
// path the page is at, and opens the one a person types in the panel's bar.
//
// The script is served from the preview's own address (a page's Content-Security-Policy
// allows 'self' more often than inline scripts), runs before the page's own scripts
// and removes its tag at once, so a React page hydrates against the HTML it rendered.
// Outside the dashboard's frame (a tab of its own) it does nothing.
import { readFileSync } from 'node:fs'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { elementSelectScript } from '@brigade/contracts'

/** Where the proxy serves the script, on every preview's address. */
export const SELECT_SCRIPT_PATH = '/__brigade/select.js'
/** And the library that draws an element, loaded once something is picked. */
export const SCREENSHOT_SCRIPT_PATH = '/__brigade/screenshot.mjs'

let screenshot: string | undefined
/** modern-screenshot's browser module: one file, no imports. */
export function screenshotScript() {
  screenshot ??= readFileSync(fileURLToPath(import.meta.resolve('modern-screenshot')), 'utf8')
  return screenshot
}

const TAG = `<script src="${SELECT_SCRIPT_PATH}"></script>`

/** How much of a page is read for its <head> before giving up and passing it through. */
const SEARCH_LIMIT = 64 * 1024

/**
 * Where the tag goes in a page's start: after <head>; once no <head> is coming (`last`),
 * after <html>, else before <body>. -1 when there is no place for it (yet).
 */
export function tagIndex(html: string, last: boolean) {
  for (const re of last ? [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i] : [/<head(\s[^>]*)?>/i]) {
    const m = re.exec(html)
    if (m) return m.index + m[0].length
  }
  return last ? html.search(/<body[\s>]/i) : -1
}

/**
 * The page with the script's tag added, streamed: its start is held only until the
 * tag's place is found (a dev server streams the rest as it renders).
 */
export function withSelectScript() {
  let held = ''
  let done = false
  const release = (last: boolean) => {
    const at = tagIndex(held, last)
    if (at < 0 && !last) return undefined
    done = true
    const out = at < 0 ? held : held.slice(0, at) + TAG + held.slice(at)
    held = ''
    return Buffer.from(out, 'latin1')
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, next) {
      if (done) return next(null, chunk)
      held += chunk.toString('latin1')
      next(null, release(held.length >= SEARCH_LIMIT))
    },
    flush(next) {
      next(null, done || !held ? null : release(true))
    },
  })
}

/** The script, as the browser runs it (contracts' element-select.ts). */
export const SELECT_SCRIPT = elementSelectScript(SCREENSHOT_SCRIPT_PATH)
