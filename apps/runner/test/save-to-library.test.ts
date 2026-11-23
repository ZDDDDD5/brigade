import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'brigade-save-to-library-'))
process.env.BRIGADE_HOME = home
after(() => rm(home, { recursive: true, force: true }))
const { libraryTools } = await import('../src/harness/tools.js')

/** save_to_library over a library where `edits` are a person's edits since the thread saved. */
async function save(input: { overwrite?: boolean }, edits: unknown[] | Error) {
  const asked: string[] = []
  const tools = libraryTools({
    access: 'read_write',
    libraryDir: '/library',
    readFile: async () => Buffer.from('hi'),
    stageFile: async () => ({ path: '/work/brief.md' }) as never,
    listFiles: async () => [],
    renderDesign: async () => ({ screenshots: [], errors: [] }),
    call: async ({ operation }) => {
      const op = operation as { name: string }
      asked.push(op.name)
      if (op.name === 'design_edits') {
        if (edits instanceof Error) throw edits
        return edits
      }
      return { path: 'social/brief.md' }
    },
  })
  const result = tools.save_to_library!.execute!(
    { file: '/work/brief.md', path: 'social/brief.md', ...input },
    { toolCallId: 'c1', messages: [] } as never,
  ) as Promise<unknown>
  return { asked, result }
}

const edit = { file: 'brief.md', by: 'Georges', at: new Date().toISOString() }

test('a save over a person edit is refused, and nothing is saved', async () => {
  const { asked, result } = await save({}, [edit])
  await assert.rejects(
    result,
    /Georges edited `social\/brief\.md`.*\/library\/social\/brief\.md.*Nothing was saved/s,
  )
  assert.deepEqual(asked, ['design_edits'])
})

test('with no edit, it saves', async () => {
  const { asked, result } = await save({}, [])
  await result
  assert.deepEqual(asked, ['design_edits', 'save'])
})

test('overwrite saves without asking', async () => {
  const { asked, result } = await save({ overwrite: true }, [edit])
  await result
  assert.deepEqual(asked, ['save'])
})

test('an API that does not know the question still saves', async () => {
  const { asked, result } = await save({}, new Error('Unknown operation'))
  await result
  assert.deepEqual(asked, ['design_edits', 'save'])
})
