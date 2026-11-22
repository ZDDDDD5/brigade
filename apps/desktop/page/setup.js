// Asks Brigade (src/setup.ts) for its steps every 1.5 seconds and draws them as a road of
// teammates: asleep while a step is to do, hopping while it is on its way, happy once done.
// The card under the road shows one step (the first not done, or the one clicked) with the
// action that fixes it. Once all are done: "Your team has moved in!".
const setup = window.brigadeSetup
/** An action's outcome: { error } when it failed. */
const run = (id) => setup.action(id).catch((error) => ({ error: String(error) }))

const WIDTH = 600
const COLORS = ['green', 'blue', 'purple', 'orange', 'yellow', 'pink']
const SHAPES = [
  '58% 42% 55% 45% / 52% 58% 42% 48%',
  '45% 55% 52% 48% / 60% 45% 55% 40%',
  '50% 50% 45% 55% / 50% 55% 45% 50%',
  '52% 48% 58% 42% / 50% 56% 44% 50%',
  '55% 45% 50% 50% / 45% 55% 45% 55%',
  '48% 52% 42% 58% / 56% 48% 52% 44%',
]
const SVG = 'http://www.w3.org/2000/svg'

if (navigator.userAgent.includes('Macintosh')) document.body.classList.add('mac')

const list = document.getElementById('steps')
const path = document.getElementById('path')
const summary = document.getElementById('summary')
const moving = document.getElementById('moving')
const ready = document.getElementById('ready')
const readyText = document.getElementById('ready-text')
const note = document.getElementById('note')
const later = document.getElementById('later')
const card = {
  root: document.getElementById('current'),
  title: document.querySelector('#current .title'),
  detail: document.querySelector('#current .detail'),
  error: document.querySelector('#current .error'),
  button: document.querySelector('#current button'),
}
const errors = new Map()
let busy = null
/** The step the person clicked, shown in the card until it is done. */
let chosen = null
let last = null

/** Each step's place on the road: spread across, gently up and down. */
function points(count) {
  const margin = count > 4 ? 56 : 80
  const gap = count > 1 ? (WIDTH - margin * 2) / (count - 1) : 0
  return Array.from({ length: count }, (_, i) => ({
    x: count > 1 ? margin + gap * i : WIDTH / 2,
    y: i % 2 ? 120 : 84,
  }))
}

/** A smooth line through the points, from the road's start to its end. */
function curve(pts) {
  const all = [{ x: 14, y: pts[0].y + 16 }, ...pts, { x: WIDTH - 14, y: pts.at(-1).y - 4 }]
  let d = `M${all[0].x} ${all[0].y}`
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1]
    const b = all[i]
    const mid = (a.x + b.x) / 2
    d += ` C${mid} ${a.y} ${mid} ${b.y} ${b.x} ${b.y}`
  }
  return d
}

function drawRoad(steps) {
  const pts = points(steps.length)
  // Lit up to the last of the first steps that are done.
  let reached = 0
  while (reached < steps.length && steps[reached].done === true) reached++
  const lit = reached === steps.length ? pts : pts.slice(0, Math.max(reached, 1))
  const shape = steps.map((s) => s.done).join()
  if (path.dataset.shape !== shape) {
    path.dataset.shape = shape
    const node = (name, attrs) => {
      const el = document.createElementNS(SVG, name)
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      return el
    }
    const defs = node('defs', {})
    const gradient = node('linearGradient', { id: 'done', x1: '0', x2: '1' })
    for (const [offset, color] of [
      ['0', '#4ed589'],
      ['.6', '#60aaf3'],
      ['1', '#8a63fe'],
    ])
      gradient.append(node('stop', { offset, 'stop-color': color }))
    defs.append(gradient)
    const children = [defs, node('path', { class: 'base', d: curve(pts) })]
    if (reached > 0) {
      const done = curve(lit)
      // Stop at the last teammate reached, unless all are.
      const end = reached === steps.length ? done : done.replace(/ C[^C]*$/, '')
      children.push(node('path', { class: 'done', d: end }))
    }
    children.push(node('path', { class: 'dots', d: curve(pts) }))
    path.replaceChildren(...children)
  }
  return pts
}

/** One teammate per step, made once and then updated, so their animations run on. */
function drawSteps(steps, pts, shown) {
  const ids = steps.map((s) => s.id).join()
  if (list.dataset.ids !== ids) {
    list.dataset.ids = ids
    list.replaceChildren(
      ...steps.map((s, i) => {
        const item = document.createElement('li')
        item.dataset.id = s.id
        item.tabIndex = 0
        item.setAttribute('role', 'button')
        const pebble = document.createElement('div')
        pebble.className = 'pb'
        pebble.style.setProperty('--c', `var(--${COLORS[i % COLORS.length]})`)
        pebble.style.setProperty('--r', SHAPES[i % SHAPES.length])
        pebble.style.setProperty('--b', `${4 + (i % 3)}s`)
        pebble.append(document.createElement('i'), document.createElement('i'))
        pebble.children[0].className = 'l'
        pebble.children[1].className = 'r'
        const label = document.createElement('div')
        label.className = 'label'
        const short = document.createElement('span')
        short.className = 'short'
        const state = document.createElement('span')
        state.className = 'state'
        const title = document.createElement('span')
        title.className = 'title visually-hidden'
        label.append(short, state, title)
        item.append(pebble, label)
        const pick = () => {
          chosen = s.id
          if (last) render(last)
        }
        item.addEventListener('click', pick)
        item.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            pick()
          }
        })
        return item
      }),
    )
  }
  steps.forEach((s, i) => {
    const item = list.children[i]
    const kind = s.done === true ? 'done' : s.done === null ? 'waiting' : 'todo'
    // Its name goes above where the road dips under it.
    const above = i % 2 === 0 && steps.length > 1
    item.className = `${kind}${above ? ' above' : ''}${s.id === shown?.id ? ' selected' : ''}`
    item.style.left = `${pts[i].x}px`
    item.style.top = `${pts[i].y}px`
    item.style.setProperty('--s', `${s.done === null ? 62 : 52}px`)
    const pebble = item.querySelector('.pb')
    pebble.classList.toggle('happy', kind === 'done')
    pebble.classList.toggle('sleep', kind === 'todo')
    pebble.classList.toggle('bob', kind === 'waiting')
    item.querySelector('.short').textContent = s.short
    item.querySelector('.state').textContent =
      kind === 'done' ? 'done ✓' : kind === 'waiting' ? 'on its way' : 'to do'
    item.querySelector('.title').textContent = s.title
    item.setAttribute('aria-label', `${s.title}: ${s.detail}`)
  })
}

function drawCard(shown) {
  card.root.hidden = !shown
  if (!shown) return
  card.title.textContent = shown.title
  card.detail.textContent = shown.detail
  card.error.hidden = !errors.has(shown.id)
  card.error.textContent = errors.get(shown.id) ?? ''
  const action = shown.action
  card.button.hidden = !action
  if (action) {
    card.button.textContent = action.label
    card.button.disabled = busy === action.id
    card.button.onclick = () => act(shown.id, action.id)
  }
}

function render(state) {
  last = state
  const { steps, done, ai, computer } = state
  document.body.classList.toggle('ready', done)
  moving.hidden = done
  ready.hidden = !done
  later.hidden = done
  if (done) {
    readyText.textContent = ai
      ? `This ${computer} is ready: your teammates work here while it is on. Give them their first job.`
      : `No Claude Code or Codex sign-in on this ${computer} yet. Last step: the AI your teammates think with.`
    document.getElementById('open').hidden = !ai
    document.getElementById('connect-ai').hidden = ai !== false
    document.getElementById('later-ai').hidden = ai !== false
    note.textContent = ai
      ? 'You can open this again from the menu: Set up Brigade.'
      : "You sign in on the vendor's own page. Brigade never sees your password."
    return
  }
  note.textContent = 'Everything goes in your own user folder. No administrator needed.'
  const count = steps.filter((s) => s.done === true).length
  summary.textContent = `Getting this ${computer} ready for your teammates: ${count} of ${steps.length} done.`
  if (chosen && steps.find((s) => s.id === chosen)?.done === true) chosen = null
  const shown =
    steps.find((s) => s.id === chosen) ??
    steps.find((s) => s.done === false && s.action) ??
    steps.find((s) => s.done !== true)
  const pts = drawRoad(steps)
  drawSteps(steps, pts, shown)
  drawCard(shown)
}

async function act(step, action) {
  busy = action
  errors.delete(step)
  if (last) render(last)
  const { error } = await run(action)
  if (error) errors.set(step, error)
  busy = null
  refresh()
}

let pending = false
async function refresh() {
  if (pending) return
  pending = true
  try {
    const current = await setup.state()
    if (current) render(current)
  } finally {
    pending = false
  }
}

later.addEventListener('click', () => run('close'))
document.getElementById('later-ai').addEventListener('click', () => run('close'))
document.getElementById('connect-ai').addEventListener('click', () => run('accounts'))
document.getElementById('open').addEventListener('click', () => run('open'))
refresh()
setInterval(refresh, 1500)
