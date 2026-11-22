// A member's notifications: the preset they chose, and the browsers, installed apps and
// Brigade.apps that receive them (src/notifications.ts sends them).
import { randomBytes } from 'node:crypto'
import {
  DesktopDeviceInput,
  PushDeviceInput,
  SetNotifyPreset,
  type DesktopDeviceCreated,
  type NotificationSettings,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import { prisma } from '../db.js'
import { hashToken } from '../hub.js'
import { sendTest, vapid } from '../notifications.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const notifications = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const member = await prisma.member.findUniqueOrThrow({
      where: { id: c.var.scope.memberId },
      select: { notify: true },
    })
    return c.json({
      preset: member.notify,
      publicKey: vapid()?.publicKey ?? null,
    } satisfies NotificationSettings)
  })

  .put('/preset', async (c) => {
    const { preset } = await parseBody(c.req.raw, SetNotifyPreset)
    await prisma.member.update({ where: { id: c.var.scope.memberId }, data: { notify: preset } })
    return c.body(null, 204)
  })

  /** This browser receives the member's notifications; a browser is one user's at a time. */
  .post('/devices', async (c) => {
    if (!vapid())
      throw new HTTPException(409, { message: 'Notifications are not set up on this Brigade' })
    const { endpoint, keys } = await parseBody(c.req.raw, PushDeviceInput)
    const device = { userId: c.var.userId, p256dh: keys.p256dh, auth: keys.auth }
    await prisma.pushDevice.upsert({
      where: { endpoint },
      create: { endpoint, ...device },
      update: device,
    })
    return c.body(null, 204)
  })

  /** This browser no longer receives them (turned off, or signing out). */
  .post('/devices/remove', async (c) => {
    const { endpoint } = await parseBody(c.req.raw, PushDeviceInput.pick({ endpoint: true }))
    await prisma.pushDevice.deleteMany({ where: { endpoint, userId: c.var.userId } })
    return c.body(null, 204)
  })

  /**
   * Brigade.app on this computer shows the user's notifications: a device of its own, whose
   * token, given once, fetches them (routes/desktop-notifications.ts). No push service needed.
   */
  .post('/desktop-devices', async (c) => {
    const { platform } = await parseBody(c.req.raw, DesktopDeviceInput)
    const token = randomBytes(32).toString('base64url')
    const device = await prisma.desktopDevice.create({
      data: { userId: c.var.userId, tokenHash: hashToken(token), platform },
      select: { id: true },
    })
    return c.json({ id: device.id, token } satisfies DesktopDeviceCreated)
  })

  /** That Brigade.app no longer shows them. */
  .post('/desktop-devices/remove', async (c) => {
    const { id } = await parseBody(c.req.raw, z.object({ id: z.string().min(1).max(100) }))
    await prisma.desktopDevice.deleteMany({ where: { id, userId: c.var.userId } })
    return c.body(null, 204)
  })

  .post('/test', async (c) => c.json(await sendTest(c.var.userId)))
