import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MouseEvent } from 'react'
import {
  addressLanding,
  clickSettings,
  closeSettings,
  hostSettings,
  openSettings,
  searchSettings,
  settingsAddress,
  settingsHref,
  SETTINGS_SECTIONS,
  showSettings,
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

/** A plain left click on a link, which says whether it was taken. */
function click() {
  let prevented = false
  const e = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: () => void (prevented = true),
  }
  return { e: e as unknown as MouseEvent<HTMLAnchorElement>, prevented: () => prevented }
}

test('opening an address that is no section does nothing', () => {
  const unhost = hostSettings()
  closeSettings()
  assert.equal(openSettings('/app/board'), false)
  assert.equal(openSettings('/app/vault'), true)
  closeSettings()
  unhost()
})

test("where no dialog shows Settings (Brigade.app's quick-capture window), a link goes to its address", () => {
  closeSettings()
  assert.equal(openSettings('/app/computers'), false)
  const link = click()
  clickSettings(link.e, '/app/computers')
  assert.equal(link.prevented(), false)
})

test('with the dialog mounted, a link to a section opens it in place', () => {
  const unhost = hostSettings()
  const link = click()
  clickSettings(link.e, '/app/accounts')
  assert.equal(link.prevented(), true)
  closeSettings()
  unhost()
})

test("a section's address loaded on its own opens it before the dialog mounts", () => {
  closeSettings()
  showSettings('/app/billing?subscribed=1')
  // The dialog mounting next finds it: openSettings now moves it, as from the dialog's nav.
  const unhost = hostSettings()
  assert.equal(openSettings('/app/usage'), true)
  closeSettings()
  unhost()
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

test("a section's address opens Settings over Today, but stays in Brigade.app's capture window", () => {
  assert.deepEqual(addressLanding(false), { behind: '/app', closed: null })
  // The capture window turns /app back into /app/capture, which has no Settings: the address
  // stays, and closing goes back to the capture page.
  assert.deepEqual(addressLanding(true), { behind: null, closed: '/app/capture' })
})
