// Picking elements in a page the dashboard shows in a frame, as Claude does: a thread's preview
// (the runner's proxy adds this script to its pages, runner/src/preview-select.ts) and a tool
// (the sandbox host adds it to the tool's pages, api/src/tools.ts). The panel around the frame
// turns its select mode on and off; while it is on, what the pointer is over is outlined, and a
// click sends that element (where it is, its React components, its HTML) to the panel instead of
// reaching the page, which puts it in the composer (preview-elements.ts). Esc in the page turns
// it off. Then the page draws the element (modern-screenshot, loaded only then from `screenshot`,
// an address the page may load scripts from) and sends that picture too. It also tells the panel
// which path the page is at, and opens the one a person types in the panel's bar.
//
// It runs before the page's own scripts and removes its tag at once, so a React page hydrates
// against the HTML it rendered. Outside a frame (a tab of its own) it does nothing.

/**
 * The script, as the browser runs it, with the address of modern-screenshot's module. Plain ES2017 in the page: no imports, no globals besides its flag. */
export const elementSelectScript = (screenshot: string) => String.raw`(() => {
  const tag = document.currentScript
  if (tag) tag.remove()
  if (window.parent === window || window.__brigadeSelect) return
  window.__brigadeSelect = true

  const ACCENT = '#7c5cff'
  // Next.js's own components, which say nothing about where an element is in the app.
  const INTERNAL = /^(Inner|Outer)?(LayoutRouter|ScrollAndFocusHandler|RenderFromTemplateContext|Redirect|NotFound|HTTPAccessFallback|ErrorBoundary|LoadingBoundary|Segment|Metadata|Viewport|Outlet|AppRouter|Router|HotReload|ServerRoot|Root$|DevRoot|AppDev|ReplaySsr|RootError|ClientPageRoot|ClientSegmentRoot|Head$|ServerInsertedHTML|PathnameContext|__next)/
  let on = false
  let origin = null
  let host = null
  let box = null
  let label = null
  let current = null
  // The crosshair over the whole page, without touching its DOM (which React hydrates).
  let cursor = null

  const post = (message, to) => window.parent.postMessage(Object.assign({ source: 'brigade-preview' }, message), to)

  function overlay() {
    if (host) return
    host = document.createElement('brigade-select')
    const root = host.attachShadow({ mode: 'closed' })
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.box{position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:2px solid ' + ACCENT + ';background:' + ACCENT + '1f;border-radius:3px;display:none;transition:background .15s}' +
      '.box.picked{background:' + ACCENT + '66}' +
      '.label{position:fixed;z-index:2147483647;pointer-events:none;display:none;max-width:min(420px,calc(100vw - 16px));overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'background:#18142a;color:#fff;font:500 12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 7px;border-radius:5px;box-shadow:0 2px 8px #0004}' +
      '.label span{color:#b9a8ff;margin-left:8px;font-weight:400}' +
      '</style><div class="box"></div><div class="label"></div>'
    box = root.querySelector('.box')
    label = root.querySelector('.label')
    document.documentElement.appendChild(host)
  }

  // A component's props worth showing: plain values, not children or callbacks.
  function plain(props) {
    const out = {}
    let n = 0
    for (const key of Object.keys(props || {})) {
      const value = props[key]
      if (key === 'children' || key === 'key' || n >= 12) continue
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
      out[key.slice(0, 100)] = String(value).slice(0, 200)
      n++
    }
    return out
  }

  function components(el) {
    let node = el
    let fiber = null
    while (node && !fiber) {
      const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'))
      fiber = key ? node[key] : null
      node = node.parentNode
    }
    const names = []
    let props = null
    for (; fiber && names.length < 40; fiber = fiber.return) {
      const type = fiber.type
      if (!type || typeof type === 'string') continue
      const inner = type.render || type.type || type
      const name = type.displayName || (inner && (inner.displayName || inner.name))
      if (!name || typeof name !== 'string' || name.length < 3 || INTERNAL.test(name)) continue
      if (!props) props = plain(fiber.memoizedProps)
      if (names[names.length - 1] !== name) names.push(name)
    }
    return { names: names.slice(0, 5).reverse(), props: props || {} }
  }

  function short(el) {
    const tag = el.tagName.toLowerCase()
    if (el.id) return tag + '#' + el.id
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''
    return cls ? tag + '.' + cls : tag
  }

  // The shortest path up from it that finds it alone, so two alike elements never share one.
  const unique = (parts) => {
    try {
      return document.querySelectorAll(parts.join(' > ')).length === 1
    } catch (error) {
      return false
    }
  }
  function selector(el) {
    const parts = []
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const tag = node.tagName.toLowerCase()
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id))
        break
      }
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag)
        break
      }
      let part = tag
      const classes = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean) : []
      for (const c of classes.slice(0, 2)) part += '.' + CSS.escape(c)
      const parent = node.parentElement
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      if (unique(parts)) break
    }
    return parts.join(' > ')
  }

  function html(el) {
    const outer = el.outerHTML
    return outer.length > 3000 ? outer.slice(0, 3000) + '…' : outer
  }

  function describe(el) {
    const rect = el.getBoundingClientRect()
    const found = components(el)
    const names = found.names
    const name = short(el)
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    const near = names[names.length - 1]
    return {
      label: (near ? near + ' › ' + name : name).slice(0, 200),
      page: (location.pathname + location.search + location.hash).slice(0, 2000),
      selector: selector(el).slice(0, 1000),
      components: names.map((n) => n.slice(0, 100)),
      props: found.props,
      size: Math.round(rect.width) + '×' + Math.round(rect.height),
      text: text.length > 300 ? text.slice(0, 300) + '…' : text,
      html: html(el),
    }
  }

  function draw() {
    if (!on || !current || !current.isConnected) {
      if (box) box.style.display = label.style.display = 'none'
      return
    }
    // Added on first use, once the page is up rather than while it loads.
    overlay()
    const r = current.getBoundingClientRect()
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
    label.textContent = short(current)
    const size = document.createElement('span')
    size.textContent = Math.round(r.width) + '×' + Math.round(r.height)
    label.appendChild(size)
    label.style.display = 'block'
    const below = r.bottom + 30 < innerHeight
    label.style.top = Math.max(4, below ? r.bottom + 6 : r.top - 30) + 'px'
    label.style.left = Math.max(4, Math.min(r.left, innerWidth - label.offsetWidth - 4)) + 'px'
  }

  const target = (e) => {
    const el = e.target
    return el && el.nodeType === 1 && el !== host ? el : null
  }
  function move(e) {
    const el = target(e)
    if (!el || el === current) return
    current = el
    draw()
  }
  function block(e) {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  function pick(e) {
    block(e)
    const el = target(e) || current
    if (!el) return
    current = el
    draw()
    box.classList.add('picked')
    setTimeout(() => box && box.classList.remove('picked'), 300)
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    post({ type: 'selected', id, element: describe(el) }, origin)
    capture(el, id, origin)
  }

  // Its picture, up to 1600 pixels on its longest side; none when the page cannot draw it.
  function capture(el, id, to) {
    const r = el.getBoundingClientRect()
    const longest = Math.max(r.width, r.height)
    if (!longest) return post({ type: 'captured', id }, to)
    const scale = Math.min(window.devicePixelRatio || 1, 1600 / longest)
    const options = { scale, type: 'image/png', timeout: 10000, autoDestruct: true }
    import(${JSON.stringify(screenshot)})
      .then((m) =>
        // A sandboxed page (a tool's) cannot reach the frame the library makes to read each
        // tag's default style: without one, it writes every style out rather than only those
        // that differ, the same picture.
        window.origin === 'null'
          ? m.createContext(el, options).then((context) => {
              context.sandbox = { contentWindow: null, remove() {} }
              return m.domToBlob(context)
            })
          : m.domToBlob(el, options),
      )
      .then(
        (image) => post({ type: 'captured', id, image }, to),
        () => post({ type: 'captured', id }, to),
      )
  }
  function key(e) {
    if (e.key !== 'Escape') return
    block(e)
    set(false)
    post({ type: 'stopped' }, origin)
  }
  function leave(e) {
    if (e.relatedTarget) return
    current = null
    draw()
  }

  // Not touchstart or touchend: cancelling them cancels the click a tap picks with.
  const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'auxclick', 'submit']
  function set(value) {
    if (value === on) return
    on = value
    const listen = on ? addEventListener : removeEventListener
    listen('pointermove', move, true)
    listen('click', pick, true)
    for (const type of BLOCKED) listen(type, block, { capture: true, passive: false })
    listen('keydown', key, true)
    listen('scroll', draw, true)
    listen('resize', draw, true)
    document[on ? 'addEventListener' : 'removeEventListener']('mouseout', leave, true)
    if (!on) current = null
    try {
      if (!cursor) {
        cursor = new CSSStyleSheet()
        cursor.replaceSync('*{cursor:crosshair!important}')
      }
      const sheets = document.adoptedStyleSheets.filter((s) => s !== cursor)
      document.adoptedStyleSheets = on ? sheets.concat(cursor) : sheets
    } catch (error) {
      // An older browser: the default cursor.
    }
    draw()
  }

  // Where the page is, for the panel's address bar: once the panel answered, and on each
  // navigation inside the page (a client-side router's pushState, Back, a #hash).
  let shown = null
  function report() {
    const page = (location.pathname + location.search + location.hash).slice(0, 2000)
    if (!origin || page === shown) return
    shown = page
    post({ type: 'location', page }, origin)
  }
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name]
    history[name] = function () {
      const result = original.apply(this, arguments)
      report()
      return result
    }
  }
  addEventListener('popstate', report)
  addEventListener('hashchange', report)

  addEventListener('message', (e) => {
    const data = e.data
    if (e.source !== window.parent || !data || data.source !== 'brigade') return
    if (data.type === 'select') {
      origin = e.origin
      set(!!data.on)
      report()
    } else if (data.type === 'hello') {
      origin = e.origin
      shown = null
      report()
    } else if (data.type === 'navigate' && typeof data.page === 'string') {
      // A path the person typed in the panel's bar, only on this page's own address
      // (a browser reads '//host' and '/\host' as another one).
      let to = null
      try {
        to = new URL(data.page, location.href)
      } catch (error) {
        return
      }
      if (to.origin === location.origin) location.assign(to.href)
    }
  })
  // Here, for the panel to show its button and turn select mode back on after a navigation.
  post({ type: 'ready' }, '*')
})()
`
