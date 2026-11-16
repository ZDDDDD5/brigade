// Whether Claude or ChatGPT can already think for teammates on this computer, for the setup
// window's last screen (setup.ts): it asks to connect one only when none is here. A login found
// is used as it is, without asking (the runner reports it: apps/runner/src/accounts.ts).
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const files = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Whether macOS's keychain holds Claude Code's login (the item only, never its secret). */
const claudeInKeychain = () =>
  new Promise<boolean>((resolve) =>
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials'], (error) =>
      resolve(!error),
    ),
  )

/**
 * Whether an AI sign-in is on this computer: the person's own Claude Code or Codex login, or an
 * account signed in through Brigade (one folder each in the runner's accounts folder). Only
 * whether they exist: nothing is read.
 */
export async function hasAiSignIn(home = homedir()): Promise<boolean> {
  const brigade = process.env.BRIGADE_HOME ?? join(home, '.brigade')
  if (files(join(brigade, 'accounts')).length > 0) return true
  const codex = process.env.CODEX_HOME ?? join(home, '.codex')
  if (existsSync(join(codex, 'auth.json'))) return true
  const claude = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
  if (existsSync(join(claude, '.credentials.json'))) return true
  return process.platform === 'darwin' && (await claudeInKeychain())
}
