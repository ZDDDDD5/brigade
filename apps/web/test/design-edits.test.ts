import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DesignEdits } from '../components/design-edits'

/** The edits' requests, answered with a new version each. */
function fakeApi() {
  const bodies: { sha256: string; ops: { id: number }[] }[] = []
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ sha256: `saved-${bodies.length}`, updatedAt: '' }), {
      status: 200,
    })
  }) as unknown as typeof fetch
  return bodies
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const change = {
  folder: 'x.design',
  file: 'index.html',
  ops: [{ id: 0, style: { translate: '20px 0px' } }],
  undo: [{ id: 0, style: { translate: null } }],
}

test('a version someone else saved drops the steps of undo made on the one before', async () => {
  const bodies = fakeApi()
  const edits = new DesignEdits({ onSaved() {}, onLost() {}, onChange() {} })
  edits.seen('x.design', 'index.html', 'original')
  edits.push(change)
  edits.flushAll()
  await settle()
  assert.equal(bodies.length, 1)
  // Its own save, as a view reports it: undo stays.
  edits.seen('x.design', 'index.html', 'saved-1')
  assert.equal(edits.canUndo, true)
  // A teammate saved a page whose elements are numbered anew: undo would change another one.
  edits.seen('x.design', 'index.html', 'teammate')
  assert.equal(edits.canUndo, false)
  assert.equal(edits.undo(), null)
  edits.flushAll()
  await settle()
  assert.equal(bodies.length, 1)
})

test('a version restored by someone else to the one first loaded drops them too', async () => {
  fakeApi()
  const edits = new DesignEdits({ onSaved() {}, onLost() {}, onChange() {} })
  edits.seen('x.design', 'index.html', 'A')
  edits.push(change)
  edits.flushAll()
  await settle()
  edits.seen('x.design', 'index.html', 'A')
  assert.equal(edits.canUndo, false)
})
