// The themes Appearance suggests (lib/suggested-themes.ts) are ones the API takes as they are, and
// every data-look or data-slot they style is still in the dashboard.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { THEME_ID, ThemeFile, themeCssProblem } from '@brigade/contracts'
import { SUGGESTED_THEMES } from '../lib/suggested-themes'

const ROOT = join(import.meta.dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === 'node_modules' || name.startsWith('.')) return []
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && name !== 'suggested-themes.ts'
      ? [readFileSync(path, 'utf8')]
      : []
  })
}

const code = [...sources(join(ROOT, 'app')), ...sources(join(ROOT, 'components'))].join('\n')

test('every suggested theme is one the API takes', () => {
  const ids = new Set<string>()
  for (const { id, theme } of SUGGESTED_THEMES) {
    assert.match(id, THEME_ID)
    assert.ok(!ids.has(id), `${id} is suggested twice`)
    ids.add(id)
    const parsed = ThemeFile.safeParse(theme)
    assert.ok(parsed.success, `${id}: ${parsed.error?.message}`)
    assert.equal(themeCssProblem(theme.css ?? ''), null, id)
  }
})

test('what the suggested themes style is still in the dashboard', () => {
  for (const { id, theme } of SUGGESTED_THEMES)
    for (const [, attribute, value] of (theme.css ?? '').matchAll(
      /\[(data-look|data-slot)="([a-z-]+)"\]/g,
    ))
      assert.ok(
        code.includes(`${attribute}="${value}"`) || code.includes(`${attribute}={'${value}'}`),
        `${id} styles ${attribute}="${value}", which is no longer in the dashboard`,
      )
})
