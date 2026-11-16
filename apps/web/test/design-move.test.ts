import assert from 'node:assert/strict'
import { test } from 'node:test'
import { movedTranslate, translateAxes } from '../lib/design-move'

test('an element with no translate moves from where it is', () => {
  assert.deepEqual(translateAxes('none'), ['0px', '0px'])
  assert.deepEqual(translateAxes(undefined), ['0px', '0px'])
  assert.equal(movedTranslate('none', 12.4, -30.6), '12px -31px')
  assert.equal(movedTranslate(undefined, 0, 5), '0px 5px')
})

test('a move adds to the translate it already has', () => {
  assert.equal(movedTranslate('10px', 5, 5), '15px 5px')
  assert.equal(movedTranslate('10px -4px', -10, 4), '0px 0px')
  assert.equal(movedTranslate('1.5px 2px', 1, 1), '2.5px 3px')
  // A third axis is kept.
  assert.equal(movedTranslate('1px 2px 3px', 1, 1), '2px 3px 3px')
})

test('an axis that is not in px is moved with calc()', () => {
  assert.deepEqual(translateAxes('calc(50% + 4px) 0px'), ['calc(50% + 4px)', '0px'])
  assert.equal(movedTranslate('-50% 0px', 8, 0), 'calc(-50% + 8px) 0px')
  assert.equal(movedTranslate('calc(50% + 4px) 0px', -8, 2), 'calc(50% + 4px - 8px) 2px')
  assert.equal(movedTranslate('50% 10%', 0, 0), '50% 10%')
})
