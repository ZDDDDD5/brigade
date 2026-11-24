// Kept apart from src/profile.ts: src/auth.ts needs it, and profile.ts's imports (logos, uploads)
// lead back to src/scope.ts, which imports auth.ts, so importing scope.ts first left
// `requireUser` used before it was set.
import { prisma } from './db.js'

/**
 * A sign-in with Google puts Google's name and picture back on each sign-in (src/auth.ts): a name
 * the person chose stays. Its picture goes to `image`, under the one they chose, so it needs
 * nothing. The update names the person by their email, the only one it carries.
 */
export async function keepChosenName(data: { name?: unknown; email?: unknown }) {
  if (typeof data.name !== 'string' || typeof data.email !== 'string') return
  const user = await prisma.user.findUnique({
    where: { email: data.email.toLowerCase() },
    select: { name: true, nameChosen: true },
  })
  if (user?.nameChosen && user.name !== data.name) return { data: { name: user.name } }
}
