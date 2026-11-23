import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-save-to-library-'))
process.env.BRIGADE_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const { libraryTools } = await import('../src/harness/tools.js')

/** save_to_library's one call to the API: the operation it sent. */
async function save(input: { base?: string }) {
  const sent: Record<string, unknown>[] = []
  const tools = libraryTools({
    access: 'read_write',
    libraryDir: '/library',
    readFile: async () => Buffer.from('hi'),
    stageFile: async () => ({ path: '/staged/brief.md', size: 2 }) as never,
    listFiles: async () => [],
    renderDesign: async () => ({ screenshots: [], errors: [] }),
    call: async ({ operation }) => {
      sent.push(operation as Record<string, unknown>)
      return { path: 'social/brief.md' }
    },
  })
  await tools.save_to_library!.execute!(
    { file: '/work/brief.md', path: 'social/brief.md', ...input },
    {
      toolCallId: 'c1',
      messages: [],
    } as never,
  )
  return sent
}

test('the save is guarded in the API, in one call: nothing is asked first', async () => {
  const sent = await save({})
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.name, 'save')
  assert.equal(sent[0]!.guard, true)
  assert.equal('base' in sent[0]!, false)
})

test('a save after a refusal names the text it built on', async () => {
  const base = 'a'.repeat(64)
  const [op] = await save({ base })
  assert.equal(op!.guard, true)
  assert.equal(op!.base, base)
})
