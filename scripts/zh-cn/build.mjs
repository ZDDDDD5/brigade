import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const releases = join(root, '.brigade-build')
mkdirSync(releases, { recursive: true })
const stage = mkdtempSync(join(releases, 'zh-'))
const web = join(stage, 'apps/web')
const run = (command, args, cwd, extra = {}) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extra } })
const files = execFileSync('git', ['ls-files', '-z', '--', 'apps/web', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json'], { cwd: root, encoding: 'utf8' })
for (const file of files.split('\0').filter(Boolean)) {
  mkdirSync(dirname(join(stage, file)), { recursive: true })
  copyFileSync(join(root, file), join(stage, file))
}
for (const folder of ['node_modules', 'apps/web/node_modules', 'apps/docs', 'packages']) {
  symlinkSync(resolve(root, folder), join(stage, folder), 'dir')
}
// Apply to the disposable copy. A changed upstream hunk fails here before it can be released.
run('git', ['apply', '--whitespace=nowarn', join(root, 'scripts/zh-cn/workbench.patch')], stage, { GIT_CEILING_DIRECTORIES: releases })
const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
run(process.execPath, ['node_modules/next/dist/bin/next', 'build'], web, {
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3000',
  BRIGADE_BUILD_ID: process.env.BRIGADE_BUILD_ID ?? revision + '-zh',
})
const link = join(releases, 'current')
const next = link + '-' + process.pid
symlinkSync(stage, next, 'dir')
renameSync(next, link)
console.log('Chinese workbench built in', web)
