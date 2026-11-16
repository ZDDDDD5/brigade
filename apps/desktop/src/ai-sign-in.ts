// Whether Claude or ChatGPT can already think for teammates on this computer, for the setup
// window's last screen (setup.ts): it asks to connect one only when none is here. A login found
// is used as it is, without asking (the runner reports it: apps/runner/src/accounts.ts).
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const files = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** The files a finished sign-in leaves in an account's folder (the runner's ACCOUNT_LOGIN_FILES). */
const LOGIN_FILES = ['.oauth-token', '.credentials.json', 'auth.json']

/**
 * Whether an account's folder holds a finished sign-in. The folder is made as a sign-in starts,
 * so one that failed leaves it empty. On a Mac, Claude Code keeps the login itself in the
 * keychain: there, its own settings file naming the account it signed in as says so.
 */
function signedIn(dir: string) {
  const names = files(dir)
  if (names.some((name) => LOGIN_FILES.includes(name))) return true
  if (!names.includes('.claude.json')) return false
  try {
    const settings = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as {
      oauthAccount?: unknown
    }
    return !!settings.oauthAccount
  } catch {
    return false
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
 * account signed in through Brigade for the workspace this computer runs (its runner's home,
 * `brigadeHome`: one folder per account). Only whether a login exists: no credential is read.
 */
export async function hasAiSignIn(brigadeHome: string, home = homedir()): Promise<boolean> {
  const accounts = join(brigadeHome, 'accounts')
  if (files(accounts).some((id) => signedIn(join(accounts, id)))) return true
  const codex = process.env.CODEX_HOME ?? join(home, '.codex')
  if (existsSync(join(codex, 'auth.json'))) return true
  const claude = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
  if (existsSync(join(claude, '.credentials.json'))) return true
  return process.platform === 'darwin' && (await claudeInKeychain())
}
