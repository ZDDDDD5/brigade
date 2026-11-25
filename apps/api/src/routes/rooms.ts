import { DirectoryLayout, emptyDirectory, RoomSettings, type AgentEvent } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import type { ScopedDb } from '../db.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

const conflict = () => new HTTPException(409, { message: '设置已在另一窗口更新，请刷新后再试。' })
const revision = z.number().int().nonnegative()
const roomView = { id: true, name: true, memberIds: true, managerId: true, revision: true } as const

export async function ownRoom(db: ScopedDb, memberId: string, id: string) {
  const room = await db.teamRoom.findFirst({ where: { id, memberId }, select: roomView })
  if (!room) throw new HTTPException(404, { message: '没有找到这个群聊。' })
  return room
}

async function checkRoster(db: ScopedDb, ids: string[]) {
  const count = await db.teammate.count({ where: { id: { in: ids }, archivedAt: null } })
  if (count !== ids.length)
    throw new HTTPException(400, { message: '请选择当前工作区的在用队友。' })
}

export const directory = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)
  .get('/', async (c) => {
    const row = await c.var.db.sidebarOrder.findFirst({
      where: { memberId: c.var.scope.memberId, list: 'directory' },
      select: { layout: true, revision: true },
    })
    return c.json(row ?? { revision: 0, layout: emptyDirectory })
  })
  .put('/', async (c) => {
    const { db, scope } = c.var
    const input = await parseBody(c.req.raw, z.object({ revision, layout: DirectoryLayout }))
    const identity = { memberId: scope.memberId, workspaceId: scope.workspaceId, list: 'directory' }
    await db.sidebarOrder.createMany({
      data: [
        { ...identity, organizationId: scope.organizationId, ids: [], layout: emptyDirectory },
      ],
      skipDuplicates: true,
    })
    const result = await db.sidebarOrder.updateMany({
      where: { ...identity, revision: input.revision },
      data: { layout: input.layout, revision: { increment: 1 } },
    })
    if (!result.count) throw conflict()
    return c.json({ layout: input.layout, revision: input.revision + 1 })
  })

export const rooms = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)
  .get('/', async (c) =>
    c.json(
      await c.var.db.teamRoom.findMany({
        where: { memberId: c.var.scope.memberId },
        select: roomView,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    ),
  )
  .post('/', async (c) => {
    const settings = await parseBody(c.req.raw, RoomSettings)
    await checkRoster(c.var.db, settings.memberIds)
    const { workspaceId, organizationId, memberId } = c.var.scope
    return c.json(
      await c.var.db.teamRoom.create({
        data: { ...settings, workspaceId, organizationId, memberId },
        select: roomView,
      }),
      201,
    )
  })
  .put('/:id', async (c) => {
    const { db, scope } = c.var
    const { id } = await ownRoom(db, scope.memberId, c.req.param('id'))
    const input = await parseBody(c.req.raw, z.object({ revision, settings: RoomSettings }))
    await checkRoster(db, input.settings.memberIds)
    const updated = await db.teamRoom.updateMany({
      where: { id, memberId: scope.memberId, revision: input.revision },
      data: { ...input.settings, revision: { increment: 1 } },
    })
    if (!updated.count) throw conflict()
    return c.json({ id, ...input.settings, revision: input.revision + 1 })
  })
  .get('/:id', async (c) => {
    const { db, scope } = c.var
    const room = await ownRoom(db, scope.memberId, c.req.param('id'))
    const cursor = c.req.query('before')
    if (cursor && !(await db.session.count({ where: { id: cursor, roomId: room.id } })))
      throw new HTTPException(400, { message: '无效的任务页码。' })
    const rows = await db.session.findMany({
      where: { roomId: room.id, startedByMemberId: scope.memberId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 31,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        title: true,
        status: true,
        teammateId: true,
        roomStopped: true,
        createdAt: true,
        tickets: { where: { status: 'open' }, select: { id: true, title: true } },
        events: {
          where: { type: { in: ['message.done', 'error'] } },
          orderBy: { seq: 'desc' },
          take: 8,
          select: { seq: true, data: true },
        },
      },
    })
    const page = rows.slice(0, 30)
    const latest = page.length
      ? await db.sessionEvent.findMany({
          where: { sessionId: { in: page.map((t) => t.id) }, type: 'turn.started' },
          distinct: ['sessionId'],
          orderBy: [{ sessionId: 'asc' }, { seq: 'desc' }],
          select: { sessionId: true, data: true },
        })
      : []
    const active = new Map(latest.map((e) => [e.sessionId, (e.data as AgentEvent).teammateId]))
    const tasks = page.map(({ events, ...t }) => ({
      ...t,
      activeId: active.get(t.id) ?? t.teammateId,
      replies: events.reverse().flatMap(({ seq, data }) => {
        const e = data as AgentEvent
        return e.type === 'message.done' || e.type === 'error'
          ? [
              {
                seq,
                teammateId: e.teammateId ?? t.teammateId,
                text: (e.type === 'error' ? e.message : e.text).slice(0, 1600),
              },
            ]
          : []
      }),
    }))
    return c.json({ room, tasks, next: rows.length > 30 ? tasks.at(-1)?.id : null })
  })
