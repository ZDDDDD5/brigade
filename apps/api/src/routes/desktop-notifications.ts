// Brigade.app's notifications (apps/desktop/src/notifications.ts): Electron has no push
// service, so the sweep (src/notifications.ts) queues what it would push, and the app fetches
// it every few seconds with its device's token. A fetch takes what is queued and says the app
// runs, which is what queues the next ones. No session: the token alone, from POST
// /api/notifications/desktop-devices.
import type { DesktopMessages, PushMessage } from '@brigade/contracts'
import { Hono } from 'hono'
import { prisma } from '../db.js'
import { hashToken } from '../hub.js'
import { DESKTOP_MESSAGE_MS } from '../notifications.js'
import type { AppEnv } from '../scope.js'

/** Its last fetch is written at most this often: a fetch every 20 s needs no write each. */
const SEEN_EVERY_MS = 30_000

async function deviceOf(authorization: string | undefined) {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1]
  if (!token) return null
  return prisma.desktopDevice.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, lastSeenAt: true },
  })
}

export const desktopNotifications = new Hono<AppEnv>()
  .get('/', async (c) => {
    const device = await deviceOf(c.req.header('authorization'))
    // Turned off, or signed out elsewhere: the app forgets its token.
    if (!device) return c.json({ error: 'Unknown device' }, 401)
    const now = new Date()
    if (now.getTime() - device.lastSeenAt.getTime() >= SEEN_EVERY_MS)
      await prisma.desktopDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } })
    const queued = await prisma.desktopMessage.findMany({
      where: { deviceId: device.id },
      select: { id: true, message: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })
    if (queued.length)
      await prisma.desktopMessage.deleteMany({ where: { id: { in: queued.map((m) => m.id) } } })
    const fresh = queued.filter((m) => now.getTime() - m.createdAt.getTime() < DESKTOP_MESSAGE_MS)
    return c.json({
      messages: fresh.map((m) => m.message as PushMessage),
    } satisfies DesktopMessages)
  })

  /** The app turns its notifications off, or its person signs out: the device goes. */
  .delete('/', async (c) => {
    const device = await deviceOf(c.req.header('authorization'))
    if (device) await prisma.desktopDevice.delete({ where: { id: device.id } }).catch(() => {})
    return c.body(null, 204)
  })
