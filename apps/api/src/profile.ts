// A person's own profile (Settings › Profile): their name and picture, the same in every
// organization they belong to. A chosen picture is kept as a logo is (src/logos.ts), in the bucket
// folder of the workspace they chose it in (every key starts with one), and its row names it
// "<workspaceId>/<version>": each version has a key of its own, and the row changes only from the
// picture this change started from, so two changes that cross never leave it naming bytes that
// are gone. Their sign-in's picture (`User.image`, Google's) stays underneath, shown again once
// the chosen one is removed.
import { userAvatarPath, type UpdateProfile } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { userAvatarKey } from './bucket.js'
import { prisma } from './db.js'
import { readLogo, removeLogo, storeLogo } from './logos.js'
import type { WorkspaceScope } from './scope.js'

/** A chosen picture's workspace and version, from its row; null when it names none. */
export function avatarParts(avatar: string | null | undefined) {
  const [workspaceId, version, ...rest] = (avatar ?? '').split('/')
  return workspaceId && version && !rest.length ? { workspaceId, version } : null
}

/** The picture to show for a person: the one they chose (a path under /api), else their sign-in's. */
export function shownImage(
  user: { id: string; image: string | null; avatar: string | null } | null,
) {
  if (!user) return null
  return user.avatar ? userAvatarPath({ id: user.id, avatar: user.avatar }) : user.image
}

/** Where a chosen picture's bytes are; null when its workspace is gone. */
async function avatarKey(userId: string, avatar: string | null) {
  const parts = avatarParts(avatar)
  if (!parts) return null
  const workspace = await prisma.workspace.findUnique({
    where: { id: parts.workspaceId },
    select: { organizationId: true },
  })
  if (!workspace) return null
  return userAvatarKey(
    { organizationId: workspace.organizationId, workspaceId: parts.workspaceId },
    userId,
    parts.version,
  )
}

/** Delete a chosen picture's bytes (logged when that fails). */
export async function removeAvatar(userId: string, avatar: string | null) {
  const key = await avatarKey(userId, avatar).catch(() => null)
  if (key) await removeLogo(key)
}

/** Change the signed-in person's name, or their picture (null: back to their sign-in's). */
export async function updateProfile(scope: WorkspaceScope, input: z.infer<typeof UpdateProfile>) {
  const userId = scope.userId
  const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  const avatar =
    input.avatar === undefined
      ? undefined
      : input.avatar === null
        ? null
        : `${scope.workspaceId}/${await storeLogo(scope, input.avatar, (version) =>
            userAvatarKey(scope, userId, version),
          )}`
  const { count } = await prisma.user.updateMany({
    where: { id: userId, ...(avatar !== undefined && { avatar: before.avatar }) },
    data: {
      ...(input.name !== undefined && { name: input.name, nameChosen: true }),
      ...(avatar !== undefined && { avatar }),
    },
  })
  if (count === 0) {
    // Another change of the picture came first: it stays, and this one's bytes go.
    if (avatar) await removeAvatar(userId, avatar)
    throw new HTTPException(409, { message: 'Your picture just changed: try again' })
  }
  if (avatar !== undefined && before.avatar) await removeAvatar(userId, before.avatar)
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
  return { name: user.name, image: shownImage(user) }
}

/**
 * A person's chosen picture, for them and anyone who shares an organization with them (members,
 * a skill's author); null when they have none, or it is not theirs to see.
 */
export async function readAvatar(viewerId: string, userId: string) {
  if (viewerId !== userId) {
    const shared = await prisma.member.findFirst({
      where: { userId, organization: { members: { some: { userId: viewerId } } } },
      select: { id: true },
    })
    if (!shared) return null
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { avatar: true } })
  const key = await avatarKey(userId, user?.avatar ?? null)
  const parts = avatarParts(user?.avatar)
  return key && parts ? readLogo(key, parts.version) : null
}

/** Clear the chosen pictures kept in a workspace being deleted: its bucket folder goes with it. */
export async function forgetAvatarsIn(workspaceId: string) {
  await prisma.user.updateMany({
    where: { avatar: { startsWith: `${workspaceId}/` } },
    data: { avatar: null },
  })
}
