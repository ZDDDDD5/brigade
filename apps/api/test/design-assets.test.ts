import assert from 'node:assert/strict'
import { test } from 'node:test'

// designs.ts reads the API's config when imported; nothing here reaches a database.
process.env.DATABASE_URL ??= 'postgresql://test@localhost/test'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { designAssets, viewToken } = await import('../src/designs.js')

const F = 'acme/landing.design'
const row = (name: string, sha256: string, contentType = 'text/css') => ({
  path: `${F}/${name}`,
  sha256,
  contentType,
})
const files = [
  row('index.html', 'h1', 'text/html'),
  row('styles.css', 'c1'),
  row('pebble.png', 'p1', 'image/png'),
  row('design.json', 'm1', 'application/json'),
  row('knobs.json', 'k1', 'application/json'),
  row('thumbnail.png', 't1', 'image/png'),
]
const swap = (name: string, sha256: string) =>
  files.map((r) => (r.path === `${F}/${name}` ? { ...r, sha256 } : r))

test('the digest changes with what the pages load', () => {
  const base = designAssets(F, files)
  assert.notEqual(designAssets(F, swap('styles.css', 'c2')), base)
  assert.notEqual(designAssets(F, swap('pebble.png', 'p2')), base)
  assert.notEqual(designAssets(F, [...files, row('app.js', 'j1', 'text/javascript')]), base)
  // In any order.
  assert.equal(designAssets(F, [...files].reverse()), base)
})

test('not with the pages, the manifest, the knobs or the picture', () => {
  const base = designAssets(F, files)
  assert.equal(designAssets(F, swap('index.html', 'h2')), base)
  assert.equal(designAssets(F, swap('design.json', 'm2')), base)
  assert.equal(designAssets(F, swap('knobs.json', 'k2')), base)
  assert.equal(designAssets(F, swap('thumbnail.png', 't2')), base)
})

test('two views of a design never share an address, even within a second', () => {
  const scope = { organizationId: 'org', workspaceId: 'ws' }
  const tokens = new Set(Array.from({ length: 20 }, () => viewToken(scope, F).token))
  assert.equal(tokens.size, 20)
})
