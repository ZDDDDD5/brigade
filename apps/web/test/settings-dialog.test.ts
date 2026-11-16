import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  closeSettings,
  openSettings,
  searchSettings,
  settingsAddress,
  settingsHref,
  SETTINGS_SECTIONS,
} from '../lib/settings-dialog'

test("each section's address opens it", () => {
  for (const { section } of SETTINGS_SECTIONS)
    assert.equal(settingsAddress(settingsHref(section))?.section, section)
})

test('/app/settings opens the first section', () => {
  assert.equal(settingsAddress('/app/settings')?.section, 'preferences')
})

test("what follows `?` goes to the section, as a provider's or Stripe's redirect brings it", () => {
  const at = settingsAddress('/app/connections?connected=c1&error=declined')
  assert.equal(at?.section, 'connections')
  assert.equal(at?.params.get('connected'), 'c1')
  assert.equal(at?.params.get('error'), 'declined')
  assert.equal(settingsAddress('/app/billing?subscribed=1')?.params.has('subscribed'), true)
})

test('other addresses are no section', () => {
  for (const href of [
    '/app',
    '/app/threads/abc',
    '/app/library?file=x',
    '/app/projects/p1/settings',
    '/app/connections/extra',
    '/preferences',
    'https://example.com/app/billing',
  ])
    assert.equal(settingsAddress(href), null, href)
})

test('opening an address that is no section does nothing', () => {
  closeSettings()
  assert.equal(openSettings('/app/board'), false)
  assert.equal(openSettings('/app/vault'), true)
  closeSettings()
})

test('the search finds a section by its name, its group or what it holds', () => {
  const found = (q: string) => searchSettings(q).map((s) => s.section)
  assert.deepEqual(
    found(''),
    SETTINGS_SECTIONS.map((s) => s.section),
  )
  assert.deepEqual(found('secrets'), ['vault'])
  assert.deepEqual(found('auto-merge'), ['preferences'])
  assert.ok(found('workspace').includes('workspace'))
  assert.deepEqual(found('Billing'), ['billing'])
  assert.deepEqual(found('nothing like it'), [])
})
