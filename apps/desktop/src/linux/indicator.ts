// The pill at the top of the screen while a teammate uses the computer, as on a Mac:
// "● Riley is using your computer  [Stop]". It hides itself 8 seconds after the last action and
// while a screenshot is taken. There is no Esc shortcut: Brigade never lets Esc interrupt a
// teammate.
//
// It is a window of a second Brigade process started with --brigade-indicator on X11 (XWayland on
// a Wayland desktop): a Wayland window can neither choose where it goes nor stay above the
// others. The two talk over the child's stdin and stdout, one JSON object a line.
import { spawn, type ChildProcess } from 'node:child_process'
import { app, BrowserWindow, screen } from 'electron'

export const INDICATOR_FLAG = '--brigade-indicator'
const HIDE_AFTER_MS = 8000

type Command = { type: 'show'; text: string } | { type: 'hide'; id?: number }

/** In Brigade.app: starts the pill's process when first needed, and keeps it. */
export class Indicator {
  private child: ChildProcess | undefined
  private shown = false
  private text = ''
  private hideTimer: NodeJS.Timeout | undefined
  private nextId = 1
  private readonly hidden = new Map<number, () => void>()

  constructor(private readonly onStop: () => void) {}

  private process() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const args = [
      // `electron .` while developing: the app's folder comes first.
      ...(process.defaultApp && process.argv[1] ? [process.argv[1]] : []),
      INDICATOR_FLAG,
      // X11, through XWayland on a Wayland desktop; Wayland itself only when there is no X.
      process.env.DISPLAY ? '--ozone-platform=x11' : '--ozone-platform=wayland',
      ...(app.commandLine.hasSwitch('no-sandbox') || process.argv.includes('--no-sandbox')
        ? ['--no-sandbox']
        : []),
    ]
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (data: string) => {
      buffer += data
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (line === 'stop') this.onStop()
        const hiddenId = /^hidden (\d+)$/.exec(line)?.[1]
        if (hiddenId) {
          this.hidden.get(Number(hiddenId))?.()
          this.hidden.delete(Number(hiddenId))
        }
      }
    })
    child.on('exit', () => {
      if (this.child === child) this.child = undefined
      for (const done of this.hidden.values()) done()
      this.hidden.clear()
    })
    child.stdin?.on('error', () => undefined)
    this.child = child
    return child
  }

  private send(command: Command) {
    try {
      this.process().stdin?.write(`${JSON.stringify(command)}\n`)
    } catch {}
  }

  show(text: string) {
    this.shown = true
    this.text = text
    this.send({ type: 'show', text })
    clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => this.hide(), HIDE_AFTER_MS)
  }

  hide() {
    clearTimeout(this.hideTimer)
    if (!this.shown) return
    this.shown = false
    this.send({ type: 'hide' })
  }

  /** Out of the way for a screenshot, then back: resolves once it is off the screen. */
  async aside<T>(work: () => Promise<T>): Promise<T> {
    if (!this.shown || !this.child) return work()
    const id = this.nextId++
    const gone = new Promise<void>((resolve) => {
      this.hidden.set(id, resolve)
      setTimeout(resolve, 500)
    })
    this.send({ type: 'hide', id })
    await gone
    // The compositor draws the next frame without it.
    await new Promise((resolve) => setTimeout(resolve, 60))
    try {
      return await work()
    } finally {
      if (this.shown) this.send({ type: 'show', text: this.text })
    }
  }

  quit() {
    clearTimeout(this.hideTimer)
    this.child?.kill()
    this.child = undefined
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;font:13px system-ui,-apple-system,"Segoe UI",Ubuntu,sans-serif;user-select:none}
#pill{display:inline-flex;align-items:center;gap:10px;height:36px;padding:0 6px 0 14px;border-radius:18px;
background:rgba(28,28,30,.92);color:#fff;white-space:nowrap;box-sizing:border-box}
#dot{width:8px;height:8px;border-radius:4px;background:#ff453a;flex:none}
button{font:inherit;font-weight:600;height:26px;padding:0 12px;border-radius:13px;border:0;background:#fff;color:#1c1c1e;cursor:pointer}
button:hover{background:#e5e5ea}
</style></head><body><div id="pill"><span id="dot"></span><span id="text"></span><button id="stop">Stop</button></div>
<script>document.getElementById('stop').onclick=()=>{location.href='brigade-indicator://stop'}</script>
</body></html>`

/** The --brigade-indicator process: one window, shown and hidden as Brigade.app asks. */
export function runIndicator() {
  app.setPath('userData', `${app.getPath('userData')}-indicator`)
  app.on('window-all-closed', () => undefined)
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({
      width: 320,
      height: 36,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: 'Brigade',
      webPreferences: { sandbox: true, contextIsolation: true, javascript: true },
    })
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true)
    window.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (url.startsWith('brigade-indicator://stop')) {
        process.stdout.write('stop\n')
        window.hide()
      }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)

    const show = async (text: string) => {
      const width = Math.ceil(
        Number(
          await window.webContents.executeJavaScript(
            `document.getElementById('text').textContent=${JSON.stringify(text)};document.getElementById('pill').getBoundingClientRect().width`,
          ),
        ),
      )
      const area = screen.getPrimaryDisplay().workArea
      window.setBounds({
        x: Math.round(area.x + (area.width - width) / 2),
        y: area.y + 8,
        width,
        height: 36,
      })
      if (!window.isVisible()) window.showInactive()
      window.setAlwaysOnTop(true, 'screen-saver')
    }

    let buffer = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (data: string) => {
      buffer += data
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let command: Command
        try {
          command = JSON.parse(line)
        } catch {
          continue
        }
        if (command.type === 'show') void show(command.text)
        else {
          window.hide()
          if (command.id) process.stdout.write(`hidden ${command.id}\n`)
        }
      }
    })
    // Brigade.app went away: so does the pill.
    process.stdin.on('end', () => app.quit())
    process.stdout.write('ready\n')
  })
}
