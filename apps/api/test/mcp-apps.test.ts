import assert from 'node:assert/strict'
import { test } from 'node:test'
import { organizationsName, redact } from '../src/connectors/types.js'

test('an account of Neon or Supabase shows as its organization', () => {
  // Neon's list_organizations gave an array, and now an object holding it under `data` (its
  // actual reply, 20 Nov 2026); Supabase's an object holding one under `organizations`.
  assert.equal(organizationsName([{ id: 'org-1', name: 'Acme' }]), 'Acme')
  assert.equal(
    organizationsName({
      data: [
        {
          id: 'org-long-queen-89613072',
          name: 'Acme',
          handle: 'acme-org-long-queen-89613072',
          plan: 'launch',
          created_at: '2026-09-20T20:29:25Z',
          managed_by: 'console',
          updated_at: '2026-10-16T13:08:25Z',
          require_mfa: false,
        },
      ],
    }),
    'Acme',
  )
  assert.equal(
    organizationsName({ organizations: [{ name: 'Acme' }, { name: 'Beta' }, { name: 'Gamma' }] }),
    'Acme +2',
  )
  assert.equal(organizationsName({ organizations: [] }), null)
  assert.equal(organizationsName('nothing'), null)
})

test('Neon and Supabase keys never leave the API', () => {
  assert.equal(redact('bad key napi_abc123XYZ'), 'bad key [redacted key]')
  assert.equal(redact('token sbp_0123abcd'), 'token [redacted key]')
})
