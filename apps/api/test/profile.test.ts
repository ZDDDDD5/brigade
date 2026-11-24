import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import pg from 'pg'

// A person's profile (src/profile.ts) against a real database: their picture's changes that cross
// never leave the row naming bytes that are gone, nor bytes no row names; only people who share
// an organization with them read it; a sign-in with Google keeps a name they chose. The local
// one of apps/api/.env, in organizations of its own that it removes at the end. Without a
// database to reach, it is skipped.
const fromEnvFile = () => {
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='))
    return line?.slice('DATABASE_URL='.length).replace(/^"|"$/g, '') || undefined
  } catch {
    return undefined
  }
}
process.env.DATABASE_URL ??= fromEnvFile() ?? 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
// The logos' bytes, in a folder of the test's own.
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'profile-'))

async function reachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2_000,
  })
  try {
    await client.connect()
    await client.query('select "avatar" from "User" limit 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}
const skip = (await reachable()) ? false : 'no database to reach (apps/api/.env DATABASE_URL)'

const { prisma } = await import('../src/db.js')
const { listObjects, userAvatarKey } = await import('../src/bucket.js')
const { readLogo } = await import('../src/logos.js')
const { avatarParts, keepChosenName, readAvatar, updateProfile } = await import('../src/profile.js')

const id = randomUUID().slice(0, 8)
const ids = {
  organization: `org-profile-${id}`,
  other: `org-profile-other-${id}`,
  user: `user-profile-${id}`,
  peer: `user-profile-peer-${id}`,
  stranger: `user-profile-stranger-${id}`,
}
let scope: Parameters<typeof updateProfile>[0]

const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')}`
const GIF = `data:image/gif;base64,${Buffer.from('GIF89a\x01\x00\x01\x00').toString('base64')}`

before(async () => {
  if (skip) return
  for (const org of [ids.organization, ids.other])
    await prisma.organization.create({ data: { id: org, name: 'Profile test', slug: org } })
  for (const user of [ids.user, ids.peer, ids.stranger])
    await prisma.user.create({
      data: { id: user, name: 'Ada', email: `${user}@example.com`, image: 'https://g.example/a' },
    })
  const member = await prisma.member.create({
    data: {
      id: `mem-${ids.user}`,
      organizationId: ids.organization,
      userId: ids.user,
      role: 'owner',
    },
  })
  await prisma.member.create({
    data: {
      id: `mem-${ids.peer}`,
      organizationId: ids.organization,
      userId: ids.peer,
      role: 'member',
    },
  })
  await prisma.member.create({
    data: {
      id: `mem-${ids.stranger}`,
      organizationId: ids.other,
      userId: ids.stranger,
      role: 'owner',
    },
  })
  const workspace = await prisma.workspace.create({
    data: { organizationId: ids.organization, name: 'Profile test' },
  })
  scope = {
    organizationId: ids.organization,
    workspaceId: workspace.id,
    userId: ids.user,
    memberId: member.id,
    role: 'owner',
  }
})

after(async () => {
  if (skip) return
  await prisma.organization.deleteMany({ where: { id: { in: [ids.organization, ids.other] } } })
  await prisma.user.deleteMany({ where: { id: { in: [ids.user, ids.peer, ids.stranger] } } })
  await prisma.$disconnect()
})

/** The row names bytes that are there, and the bucket keeps nothing else. */
async function consistent() {
  const { avatar } = await prisma.user.findUniqueOrThrow({ where: { id: ids.user } })
  const kept = await listObjects(
    `${scope.organizationId}/${scope.workspaceId}/avatars/${ids.user}/`,
  )
  if (!avatar) return assert.deepEqual(kept, [])
  const { version } = avatarParts(avatar)!
  const key = userAvatarKey(scope, ids.user, version)
  assert.ok(await readLogo(key, version), `${avatar} is in the bucket`)
  assert.deepEqual(kept, [key])
}

test(
  'a chosen picture shows over the sign-in one, and removing it brings that back',
  { skip },
  async () => {
    const first = await updateProfile(scope, { avatar: PNG })
    assert.match(first.image!, new RegExp(`^/users/${ids.user}/avatar\\?v=`))
    await consistent()
    const second = await updateProfile(scope, { name: 'Ada L.', avatar: GIF })
    assert.notEqual(second.image, first.image)
    assert.equal(second.name, 'Ada L.')
    await consistent()
    assert.equal((await updateProfile(scope, { avatar: null })).image, 'https://g.example/a')
    await consistent()
  },
)

test(
  'an upload and a removal that cross leave the row and the bucket agreeing',
  { skip },
  async () => {
    for (let round = 0; round < 8; round++) {
      await updateProfile(scope, { avatar: PNG }).catch(() => undefined)
      const results = await Promise.allSettled([
        updateProfile(scope, { avatar: round % 2 ? GIF : PNG }),
        updateProfile(scope, { avatar: null }),
        updateProfile(scope, { avatar: GIF }),
      ])
      for (const r of results)
        if (r.status === 'rejected') assert.match(String(r.reason), /just changed/)
      await consistent()
    }
  },
)

test('only people who share an organization see a chosen picture', { skip }, async () => {
  await updateProfile(scope, { avatar: PNG })
  assert.ok(await readAvatar(ids.user, ids.user))
  assert.ok(await readAvatar(ids.peer, ids.user))
  assert.equal(await readAvatar(ids.stranger, ids.user), null)
})

test(
  "a sign-in with Google keeps a name the person chose, and updates one they didn't",
  { skip },
  async () => {
    const email = `${ids.peer}@EXAMPLE.com`
    assert.equal(await keepChosenName({ name: 'Google Name', email }), undefined)
    await updateProfile({ ...scope, userId: ids.peer }, { name: 'Bob' })
    assert.deepEqual(await keepChosenName({ name: 'Google Name', email }), {
      data: { name: 'Bob' },
    })
    assert.equal(await keepChosenName({ email }), undefined)
  },
)
