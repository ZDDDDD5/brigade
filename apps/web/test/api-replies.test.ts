import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { answerOf, api, ApiError, isList, preload } from '../lib/api'

// What `api` gives for a reply: its JSON, or an ApiError. A reply it cannot read is an error,
// never `{}` taken for the list asked for ("(x ?? []) is not iterable" on the dashboard).

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
const answer = (body: BodyInit | null, status = 200) => {
  globalThis.fetch = async () => new Response(body, { status })
}

test('a JSON reply is what it says', async () => {
  answer(JSON.stringify([{ id: 't1' }]))
  assert.deepEqual(await api('/threads'), [{ id: 't1' }])
})

test('a 2xx reply that is not JSON is an error, not {}', async () => {
  answer('<!doctype html><title>Bad gateway</title>')
  await assert.rejects(api('/threads'), (e) => e instanceof ApiError && e.status === 200)
})

test('a reply cut off as it is read is an error, not {}', async () => {
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[{"id":'))
          controller.error(new TypeError('network error'))
        },
      }),
    )
  await assert.rejects(api('/threads'), ApiError)
})

test('an empty 2xx reply is still {}, and 204 nothing', async () => {
  answer('')
  assert.deepEqual(await api('/threads/t1/read', { method: 'POST' }), {})
  answer(null, 204)
  assert.equal(await api('/threads/t1/read', { method: 'POST' }), undefined)
})

test('an error reply keeps its message and body, readable or not', async () => {
  answer(JSON.stringify({ error: 'Not found', code: 'gone' }), 404)
  await assert.rejects(
    api('/threads/x'),
    (e) =>
      e instanceof ApiError &&
      e.message === 'Not found' &&
      (e.body as { code?: string }).code === 'gone',
  )
  answer('oops', 502)
  await assert.rejects(api('/threads/x'), (e) => e instanceof ApiError && e.status === 502)
})

// What `useApi` sets and keeps goes through `answerOf`: a list asked for (`isList`) that comes
// back as anything else is an error, so it replaces nothing and is not kept.

test('a list asked for that comes back as an object or empty is an error', async () => {
  for (const body of ['{"items":[]}', '{}', '']) {
    answer(body)
    await assert.rejects(answerOf('/threads', { accept: isList }), ApiError)
  }
  answer('[{"id":"t1"}]')
  assert.deepEqual(await answerOf('/threads', { accept: isList }), [{ id: 't1' }])
  // Without `accept`, any JSON goes, as before.
  answer('{"items":[]}')
  assert.deepEqual(await answerOf('/threads'), { items: [] })
})

test('the request sent ahead is checked too', async () => {
  answer('{}')
  preload('/threads?ahead')
  await assert.rejects(answerOf('/threads?ahead', { opening: true, accept: isList }), ApiError)
})
