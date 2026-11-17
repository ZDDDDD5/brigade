import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialAsked } from '../lib/credential-ask'

// A credential's approval reads as the credential, with the teammate's why (thread-view).

test('a use or fill of a credential gives its id and the why, trimmed', () => {
  assert.deepEqual(
    credentialAsked('use_credential', { credentialId: 'c1', purpose: '  To count sign-ups ' }),
    { credentialId: 'c1', purpose: 'To count sign-ups' },
  )
  assert.deepEqual(
    credentialAsked('mcp__harness-tools__fill_credential', { credentialId: 'c2', submit: true }),
    { credentialId: 'c2' },
  )
})

test('an empty why is left out', () => {
  assert.deepEqual(credentialAsked('use_credential', { credentialId: 'c1', purpose: ' ' }), {
    credentialId: 'c1',
  })
})

test('any other tool, or no credential id, is not a credential ask', () => {
  assert.equal(credentialAsked('save_credential', { credentialId: 'c1' }), undefined)
  assert.equal(credentialAsked('list_credentials', {}), undefined)
  assert.equal(credentialAsked('use_credential', {}), undefined)
  assert.equal(credentialAsked('use_credential', 'raw'), undefined)
})
