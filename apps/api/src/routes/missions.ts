// Missions (docs/missions.md), from the dashboard, behind the `missions` feature: one row per
// mission, and the week's agenda across them. Computed on each read from the missions' threads,
// routines, wake-ups, planned actions and outputs.
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { featuresOfUser, requireFeature } from '../features.js'
import { CreateMission, UpdateMission } from '@brigade/contracts'
import { createMission, listMissions, missionWeek, updateMission } from '../initiatives.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

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

  // A mission made by a member, with the threads it gathers. Not a viewer's: it steers work.
  .post('/', async (c) => {
    if (c.var.scope.role === 'viewer')
      throw new HTTPException(403, { message: 'Viewers cannot make missions' })
    const input = await parseBody(c.req.raw, CreateMission)
    return c.json(await createMission(c.var.db, c.var.scope, input), 201)
  })

  .patch('/:id', async (c) => {
    if (c.var.scope.role === 'viewer')
      throw new HTTPException(403, { message: 'Viewers cannot change missions' })
    const input = await parseBody(c.req.raw, UpdateMission)
    return c.json(await updateMission(c.var.db, c.var.scope, c.req.param('id'), input))
  })
