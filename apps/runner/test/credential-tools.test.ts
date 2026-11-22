import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialTools } from '../src/harness/tools.js'

const options = { toolCallId: 'call-1', messages: [] } as never

// The why a teammate gives goes to the API, which shows it to the person asked to allow it.
const recording = () => {
  const purposes: (string | undefined)[] = []
  const tools = credentialTools({
    canFill: true,
    list: async () => [],
    env: async (_id, _call, purpose) => {
      purposes.push(purpose)
      return {
        file: '/tmp/x.env',
        variables: ['DATABASE_URL'],
        credential: { name: 'DB', details: {} },
      }
    },
    fill: async (_id, _submit, _call, purpose) => {
      purposes.push(purpose)
      return {}
    },
    save: async () => ({}),
  })
  return { tools, purposes }
}

test('use_credential and fill_credential pass on their why, trimmed', async () => {
  const { tools, purposes } = recording()
  await tools.use_credential!.execute!(
    { credentialId: 'c1', purpose: '  To count sign-ups ' },
    options,
  )
  await tools.fill_credential!.execute!(
    { credentialId: 'c2', purpose: 'To check the invoice' },
    options,
  )
  assert.deepEqual(purposes, ['To count sign-ups', 'To check the invoice'])
})

test('no why, or an empty one, passes none; a long one is cut', async () => {
  const { tools, purposes } = recording()
  await tools.use_credential!.execute!({ credentialId: 'c1' }, options)
  await tools.fill_credential!.execute!({ credentialId: 'c2', purpose: '   ' }, options)
  await tools.use_credential!.execute!({ credentialId: 'c1', purpose: 'x'.repeat(400) }, options)
  assert.deepEqual(purposes, [undefined, undefined, 'x'.repeat(300)])
})
