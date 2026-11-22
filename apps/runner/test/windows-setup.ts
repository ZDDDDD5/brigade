// On Windows, what the runner does as it starts (index.ts): Git for Windows' tools on the PATH,
// before any test runs the runner's commands. scripts/ci/test.mjs imports it there.
import { useWindowsTools } from '../src/windows.js'

useWindowsTools()
