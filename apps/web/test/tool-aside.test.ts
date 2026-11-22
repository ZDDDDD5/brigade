// A tool in the document panel steps aside for the page it covers (lib/tool-aside.ts): on a
// phone, Ask from a library tool must show the thread it opens, not leave the tool over it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { minimizesOnPageChange } from '../lib/tool-aside'

const phone = {
  inDocuments: true,
  hidden: false,
  wide: false,
  shownAt: '/app/library',
  pathname: '/app/threads/t1',
}

test('below wide screens, another page minimizes the tool that covers it', () => {
  assert.equal(minimizesOnPageChange(phone), true)
})

test('it stays on the same page, on a wide screen, once out of sight, or beside a thread', () => {
  assert.equal(minimizesOnPageChange({ ...phone, pathname: phone.shownAt }), false)
  assert.equal(minimizesOnPageChange({ ...phone, wide: true }), false)
  assert.equal(minimizesOnPageChange({ ...phone, hidden: true }), false)
  assert.equal(minimizesOnPageChange({ ...phone, inDocuments: false }), false)
})
