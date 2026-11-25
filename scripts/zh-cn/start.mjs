import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Resolve once: a new build may replace the symlink while this server is running.
const release = realpathSync(
  fileURLToPath(new URL('../../.brigade-build/current', import.meta.url)),
)
process.env.BRIGADE_BUILD_ID = readFileSync(join(release, 'BUILD_ID'), 'utf8').trim()
process.chdir(join(release, 'apps/web'))
process.argv = [
  process.execPath,
  'next',
  'start',
  '--hostname',
  process.env.HOSTNAME_ZH ?? '127.0.0.1',
  '--port',
  process.env.PORT ?? '3002',
]
await import(pathToFileURL(join(process.cwd(), 'node_modules/next/dist/bin/next')).href)
