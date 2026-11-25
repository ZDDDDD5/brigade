import { z } from 'zod'

const ids = z.array(z.string().min(1).max(160)).max(1000)
const section = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(64),
  collapsed: z.boolean(),
  items: ids,
})
export const DirectoryLayout = z
  .object({
    pins: ids,
    order: ids,
    groups: z.array(section).max(100),
  })
  .refine(({ groups }) => {
    const members = groups.flatMap((g) => g.items)
    return (
      new Set(groups.map((g) => g.id)).size === groups.length &&
      new Set(members).size === members.length
    )
  }, 'Duplicate group or membership')
export type DirectoryLayout = z.infer<typeof DirectoryLayout>
export const emptyDirectory: DirectoryLayout = { pins: [], order: [], groups: [] }
export type DirectoryState = { revision: number; layout: DirectoryLayout }

export const RoomSettings = z
  .object({
    name: z.string().trim().min(1).max(80),
    managerId: z.string().min(1).max(100),
    memberIds: z.array(z.string().min(1).max(100)).min(2).max(32),
  })
  .refine(
    (s) => s.memberIds.includes(s.managerId) && new Set(s.memberIds).size === s.memberIds.length,
    'Choose a manager from the room members',
  )
export type TeamRoom = z.infer<typeof RoomSettings> & { id: string; revision: number }
