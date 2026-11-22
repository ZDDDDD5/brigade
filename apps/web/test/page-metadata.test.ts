import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DESCRIPTION_MAX, fitDescription, pageMetadata } from '../lib/page-metadata'
import { RELEASES } from '../lib/changelog'

test('a short description is kept as it is', () => {
  assert.equal(fitDescription('One line.'), 'One line.')
})

test('a long description keeps its whole sentences that fit', () => {
  const first = `${'a'.repeat(100)}.`
  assert.equal(fitDescription(`${first} ${'b'.repeat(100)}. Last.`), first)
})

test('a long first sentence is cut at a word, with an ellipsis', () => {
  const text = `${'word '.repeat(50)}end.`
  const fit = fitDescription(text)
  assert.ok(fit.length <= DESCRIPTION_MAX, `${fit.length}`)
  assert.match(fit, /word…$/)
})

test('pages get a description that fits a search result', () => {
  for (const r of RELEASES) {
    const d = pageMetadata(`/changelog/${r.slug}`, r.title, r.summary).description ?? ''
    assert.ok(d.length > 0 && d.length <= DESCRIPTION_MAX, `${r.slug}: ${d.length}`)
  }
})
