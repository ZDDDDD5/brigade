// The logins of the accounts signed in through Brigade on a cloud computer (a Claude token, a
// Claude or Codex login file), backed up to the API as they change, which seals them with the
// vault's key: a computer that replaces this one is signed in without anyone signing in again.
// Codex rotates its refresh token at each refresh, the previous one dying then: so each change is
// sent, not a copy now and then, and only the computer the API has for the account gets them
// back. The runner owns these folders (ACCOUNTS_DIR); teammates write in them too, so a file is
// read without following a link, and written by renaming a new file over it.
//
// Codex (0.167 on) saves a refreshed login as a new file renamed over auth.json, through the
// teammate's link to it, with mode 0600 and the user that ran it as owner: neither the runner nor
// the account's other teammates can read it then. Such a file is shared again before the login
// is read: only the shared login files (auth.json, its lock, .credentials.json), by the runner
// when it owns them, else by the root helper's share-login, and never the runner's own token. A
// login still unreadable is said, and fails the backup the API asks for before a replacement,
// never skipped in silence: the copy the API keeps would go stale and sign the account out on
// the next computer (Nov 18: a replaced computer got a Codex login whose refresh token was spent).
import { createHash, randomUUID } from 'node:crypto'
import { constants, watch } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ACCOUNT_LOGIN_FILES, type AccountLogin } from '@brigade/contracts'
import { ACCOUNTS_DIR, CLOUD } from './config.js'
import { shareAccount, shareLogin } from './teammates.js'

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const FILE_MAX = 64 * 1024
/** Only the runner reads it (accounts.ts): written last, after the folder is shared. */
const TOKEN_FILE = '.oauth-token'
/** What a harness rewrites in an account's folder, which its teammates must still read and write. */
const SHARED_FILES = ['auth.json', 'auth.json.lock', '.credentials.json']

/** A login file is there, but the runner may not read it. */
export class LoginUnreadable extends Error {}

/** An account's login files as they are now, or null without any. */
export async function readLogin(dir: string): Promise<AccountLogin | null> {
  const files: AccountLogin['files'] = []
  for (const name of ACCOUNT_LOGIN_FILES) {
    const handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: NodeJS.ErrnoException) => {
        // Missing, or a link (never followed): not a login file.
        if (error.code === 'EACCES' || error.code === 'EPERM')
          throw new LoginUnreadable(`${name} cannot be read (${error.code})`)
        return null
      },
    )
    if (!handle) continue
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > FILE_MAX) continue
      files.push({ name, content: (await handle.readFile()).toString('base64') })
    } finally {
      await handle.close()
    }
  }
  if (files.length === 0) return null
  const sha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  return { files, sha256 }
}

/**
 * Write an account's login files back into its folder, made if needed, as this computer's
 * runner had them. Each file is a new one renamed over whatever is there, so a link a teammate
 * planted is replaced, never followed.
 */
export async function writeLogin(dir: string, accountId: string, login: AccountLogin) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const put = async (name: string, content: string, mode: number) => {
    const temp = join(dir, `.restore-${randomUUID()}`)
    const handle = await open(temp, 'wx', mode)
    try {
      await handle.writeFile(Buffer.from(content, 'base64'))
    } finally {
      await handle.close()
    }
    await chmod(temp, mode)
    await rename(temp, join(dir, name)).catch(async (error: unknown) => {
      await rm(temp, { force: true })
      throw error
    })
  }
  for (const file of login.files)
    if (file.name !== TOKEN_FILE) await put(file.name, file.content, 0o660)
  // Teammate users reach the login files through the folder's group (link-account).
  if (CLOUD) await shareAccount(accountId)
  const token = login.files.find((file) => file.name === TOKEN_FILE)
  if (token) await put(TOKEN_FILE, token.content, 0o600)
}

/**
 * The shared login files of the account's folder a harness left unshared: owned by another user,
 * or without the group's read and write. The runner's own token is never among them.
 */
export async function unsharedFiles(dir: string, uid = process.getuid?.()) {
  const found: { name: string; own: boolean }[] = []
  for (const name of SHARED_FILES) {
    const info = await lstat(join(dir, name)).catch(() => null)
    if (!info?.isFile()) continue
    const own = uid === undefined || info.uid === uid
    if (!own || (info.mode & 0o060) !== 0o060) found.push({ name, own })
  }
  return found
}

/** Group read and write on a file of the runner's own, never through a link. */
async function shareOwn(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.chmod(0o660)
  } finally {
    await handle.close()
  }
}

/**
 * Keep the API's copy of each account's login as it is here: on any change in the accounts'
 * folders (a debounced watch), and each minute in case a change went unseen.
 */
export class AccountBackups {
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly options: {
      put: (accountId: string, login: AccountLogin) => Promise<void>
      /** What was last sent (or put back) for an account, kept across restarts. */
      sent: (accountId: string) => string | undefined
      noteSent: (accountId: string, sha256: string) => void
      /** Nothing is sent until this resolves: a computer putting backups back has none yet. */
      ready: () => Promise<void>
      /** Give the account's shared login files back to the runner and its teammates (share-login). */
      share?: (accountId: string) => Promise<unknown>
    },
  ) {}

  private running: Promise<void> | undefined
  /** The pass that starts once the one running is done: a caller that comes later joins it. */
  private queued: Promise<void> | undefined

  /** Accounts whose login could not be read, said once until it can be again. */
  private readonly unreadable = new Set<string>()

  start() {
    setInterval(() => this.soon(0), 60_000).unref()
    try {
      watch(ACCOUNTS_DIR, { recursive: true }, () => this.soon(2_000)).on('error', () => undefined)
    } catch (error) {
      console.warn(`not watching account logins: ${String(error)}`)
    }
    this.soon(5_000)
  }

  /**
   * Each account's login sent, when it changed since, by a pass that starts now or after the one
   * running: never one that started before the call, which may have read a login since rewritten.
   * Rejects with what could not be backed up.
   */
  sync(): Promise<void> {
    if (this.queued) return this.queued
    if (!this.running) return this.pass()
    const queued = this.running
      .catch(() => undefined)
      .then(() => {
        this.queued = undefined
        return this.pass()
      })
    this.queued = queued
    return queued
  }

  private pass() {
    const running = this.syncAll().finally(() => {
      if (this.running === running) this.running = undefined
    })
    this.running = running
    return running
  }

  private soon(ms: number) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.sync().catch(() => undefined), ms)
    this.timer.unref()
  }

  private async syncAll() {
    await this.options.ready()
    const ids = (await readdir(ACCOUNTS_DIR).catch(() => [] as string[])).filter((id) =>
      SAFE_ID.test(id),
    )
    const share = this.options.share ?? (CLOUD ? shareLogin : undefined)
    const failed: string[] = []
    for (const accountId of ids) {
      const dir = join(ACCOUNTS_DIR, accountId)
      let login: AccountLogin | null
      try {
        await this.shareAgain(accountId, dir, share)
        login = await readLogin(dir)
      } catch (error) {
        if (!this.unreadable.has(accountId))
          console.warn(
            `could not read the login of ${accountId}, so it is not backed up: ${String(error)}`,
          )
        this.unreadable.add(accountId)
        failed.push(`the login of ${accountId} could not be read: ${String(error)}`)
        continue
      }
      this.unreadable.delete(accountId)
      if (!login || this.options.sent(accountId) === login.sha256) continue
      try {
        await this.options.put(accountId, login)
      } catch (error) {
        // Another computer's account, or one removed: not sent again until it changes.
        if ((error as { status?: number }).status !== 404) {
          console.warn(`could not back up the login of ${accountId}: ${String(error)}`)
          failed.push(`the login of ${accountId} was not backed up: ${String(error)}`)
          continue
        }
      }
      this.options.noteSent(accountId, login.sha256)
    }
    if (failed.length) throw new Error(failed.join('; '))
  }

  /** The folder's unshared login files shared again: the runner's own by itself, others by root. */
  private async shareAgain(
    accountId: string,
    dir: string,
    share: ((accountId: string) => Promise<unknown>) | undefined,
  ) {
    let others = false
    for (const { name, own } of await unsharedFiles(dir)) {
      if (own) await shareOwn(join(dir, name)).catch(() => (others = true))
      else others = true
    }
    if (others && share)
      await share(accountId).catch((error: unknown) =>
        console.warn(`could not share the login files of ${accountId}: ${String(error)}`),
      )
  }
}
