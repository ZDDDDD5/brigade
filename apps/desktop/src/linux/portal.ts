// Screenshots through the desktop portal (org.freedesktop.portal.Screenshot): on Wayland the only
// way to read the screen. The first one asks the person ("Allow Brigade to take screenshots?"),
// and the desktop remembers the answer. Interactive, it is the desktop's own screenshot tool, for
// Brigade.app's screenshot shortcut.
import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Bus, variant } from './dbus.js'

export class PortalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const DESKTOP = 'org.freedesktop.portal.Desktop'
const PATH = '/org/freedesktop/portal/desktop'

let counter = 0

/**
 * A screenshot of the whole desktop, as PNG bytes (the portal's file is removed), or undefined
 * when the person cancelled an interactive one.
 */
export async function portalScreenshot(
  bus: Bus,
  { interactive = false, timeoutMs = 60_000 } = {},
): Promise<Buffer | undefined> {
  const token = `brigade${process.pid}_${++counter}`
  const sender = bus.uniqueName.replace(/^:/, '').replace(/\./g, '_')
  const requestPath = `${PATH}/request/${sender}/${token}`
  await bus.match(
    `type='signal',interface='org.freedesktop.portal.Request',member='Response',path='${requestPath}'`,
  )
  const response = new Promise<[number, Record<string, unknown>]>((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.off('signal', listener)
      reject(
        new PortalError(
          'permission_missing',
          'The desktop did not answer the screenshot request in time: a dialog asking to allow ' +
            'Brigade to take screenshots may be waiting on the screen. Ask the person to allow it.',
        ),
      )
    }, timeoutMs)
    const listener = (signal: { path: string; member: string; body: unknown[] }) => {
      if (signal.path !== requestPath || signal.member !== 'Response') return
      clearTimeout(timer)
      bus.off('signal', listener)
      resolve(signal.body as [number, Record<string, unknown>])
    }
    bus.on('signal', listener)
  })
  try {
    await bus.call({
      destination: DESKTOP,
      path: PATH,
      interface: 'org.freedesktop.portal.Screenshot',
      member: 'Screenshot',
      signature: 'sa{sv}',
      body: [
        '',
        {
          handle_token: variant('s', token),
          interactive: variant('b', interactive),
          modal: variant('b', false),
        },
      ],
    })
  } catch (error) {
    response.catch(() => undefined)
    throw new PortalError(
      'not_supported',
      `This desktop has no screenshot portal: ${(error as Error).message}`,
    )
  }
  const [code, results] = await response
  if (code === 1 && interactive) return undefined
  if (code !== 0)
    throw new PortalError(
      'permission_missing',
      'Screenshots are not allowed for Brigade on this computer. Ask the person to allow them: the ' +
        'desktop asks the first time (Allow), and keeps the answer in its privacy settings.',
    )
  const uri = String(results.uri ?? '')
  if (!uri.startsWith('file://'))
    throw new PortalError('failed', 'The desktop gave no screenshot file')
  const file = fileURLToPath(uri)
  try {
    return await readFile(file)
  } finally {
    await rm(file, { force: true })
  }
}
