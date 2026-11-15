// Missions (docs/missions.md), from the dashboard, behind the `missions` feature: one row per
// mission, and the week's agenda across them. Computed on each read from the missions' threads,
// routines, wake-ups, planned actions and outputs.
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { featuresOfUser, requireFeature } from '../features.js'
import { listMissions, missionWeek } from '../initiatives.js'
import { requireUser, requireWorkspace, type AppEnv } from '../scope.js'

const DAY = 24 * 60 * 60_000

export const missionRoutes = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)
  .use(async (c, next) => {
    requireFeature(await featuresOfUser(c.var.scope.userId, c.var.scope.workspaceId), 'missions')
    await next()
  })

  .get('/', async (c) => c.json({ missions: await listMissions(c.var.db, c.var.scope) }))

  // The week from `from` (the start of the member's day, ISO 8601), else from now.
  .get('/week', async (c) => {
    const given = c.req.query('from')
    const from = given ? new Date(given) : new Date()
    if (Number.isNaN(from.getTime()) || Math.abs(from.getTime() - Date.now()) > 366 * DAY)
      throw new HTTPException(400, { message: '`from` is an ISO 8601 time within a year' })
    return c.json(await missionWeek(c.var.db, from))
  })
