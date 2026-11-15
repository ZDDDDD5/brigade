import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { COMPARISONS } from '../lib/compare'
import { GUIDES } from '../lib/guides'
import { isPublicPage } from '../lib/public-pages'

const web = join(import.meta.dirname, '..')
const DAY = /^\d{4}-\d{2}-\d{2}$/

test('each guide has a unique slug, a public page and fits in search results', () => {
  const slugs = GUIDES.map((g) => g.slug)
  assert.equal(new Set(slugs).size, slugs.length)
  for (const g of GUIDES) {
    assert.match(g.slug, /^[a-z0-9-]+$/)
    assert.equal(isPublicPage(`/guides/${g.slug}`), true, g.slug)
    assert.ok(g.metaTitle.length <= 60, `${g.slug}: metaTitle is ${g.metaTitle.length} characters`)
    assert.ok(
      g.description.length <= 170,
      `${g.slug}: description is ${g.description.length} characters`,
    )
    assert.match(g.published, DAY, g.slug)
    assert.match(g.updated, DAY, g.slug)
    assert.ok(g.updated >= g.published, g.slug)
  }
})

test('each guide shows its pictures, its questions and its sources', () => {
  for (const g of GUIDES) {
    assert.ok(existsSync(join(web, 'public', g.image.src)), `${g.slug}: ${g.image.src} is missing`)
    for (const [, src = ''] of g.body.matchAll(/!\[[^\]]*\]\((\/[^\s)]+)/g))
      assert.ok(existsSync(join(web, 'public', src)), `${g.slug}: ${src} is missing`)
    assert.ok(g.faq.length >= 3, `${g.slug} has too few questions`)
    assert.ok(g.sources.length > 0, `${g.slug} has no sources`)
    for (const s of g.sources) assert.match(s.url, /^https:\/\//, `${g.slug}: ${s.url}`)
  }
})

test('links between the site’s pages lead somewhere', () => {
  const guides = new Set(GUIDES.map((g) => g.slug))
  const comparisons = new Set(COMPARISONS.map((x) => x.slug))
  for (const g of GUIDES)
    for (const [, path = ''] of g.body.matchAll(/\]\((\/[a-z0-9/-]*)\)/g)) {
      const [, section, slug = ''] = path.split('/')
      if (section === 'guides') assert.ok(guides.has(slug), `${g.slug}: ${path}`)
      else if (section === 'compare') assert.ok(comparisons.has(slug), `${g.slug}: ${path}`)
      else assert.equal(path, '/', `${g.slug}: ${path}`)
    }
})
