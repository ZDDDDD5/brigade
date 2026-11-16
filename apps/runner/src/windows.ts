// The runner on Windows: one runner, with this layer where Windows differs from macOS and Linux.
//
// - POSIX scripts (the runner's own `sh -c` commands, the harnesses' commands) run in Git for
//   Windows' bash, which the installer puts beside the runner (install.ps1, bin\git-path.txt);
//   Claude Code uses that same bash for its Bash tool (CLAUDE_CODE_GIT_BASH_PATH). Its Unix tools
//   (usr\bin: sh, cat, find, head, GNU tar…) come first on the runner's PATH, so the commands the
//   runner runs find them as on Linux, before Windows' own find, sort and tar, which differ.
// - Harnesses see the computer through POSIX paths (they join them with path.posix): the local
//   sandbox gives them Git Bash's (/c/Users/…) and turns them back into Windows paths for files
//   (toNative). Bash turns them into Windows paths itself for the Windows programs it starts.
// - No process groups: a turn or a preview is stopped with its whole process tree (taskkill /T).
//   Node puts the processes it starts in a job that ends them when the runner ends, unless they
//   are detached; a detached one gets no console, and every console program it starts then opens
//   a window of its own. So nothing is detached here: what must outlive the runner (a turn's
//   bridge an update hands over) is started by a shell, whose children are not in that job.
// - Teammates run as the person's own Windows account: Windows has no sudo, and no per-teammate
//   users as a cloud computer has (that is CLOUD, Linux only).
import { execFile, spawn, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WINDOWS = process.platform === 'win32'

/** Where the installer put the runner: <install dir>\runner\dist\windows.js. */
const INSTALL_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const firstLine = (file: string) => {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/)[0]!.trim() || undefined
  } catch {
    return undefined
  }
}

/** Git for Windows' folder, holding bin\bash.exe and cmd\git.exe: BRIGADE_GIT_DIR, the
 * installer's, or the person's own Git for Windows, found from git.exe on the PATH. */
export function gitHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env.BRIGADE_GIT_DIR, firstLine(join(INSTALL_DIR, 'bin', 'git-path.txt'))]
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'git.exe'))) candidates.push(dirname(dir))
  }
  candidates.push(
    join(env.ProgramFiles ?? 'C:\\Program Files', 'Git'),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Git')] : []),
  )
  return candidates.find((dir) => dir && existsSync(join(dir, 'bin', 'bash.exe')))
}

let bashPath: string | undefined
/** Git for Windows' bash. */
export function windowsBash() {
  bashPath ??= (() => {
    const home = gitHome()
    if (!home)
      throw new Error(
        'Git for Windows is missing: install Brigade again, or Git for Windows from git-scm.com',
      )
    return join(home, 'bin', 'bash.exe')
  })()
  return bashPath
}

/**
 * The program that runs a POSIX script: `sh` or `bash` on macOS and Linux, Git for Windows' bash
 * on Windows (its sh is the same bash).
 */
export const posixShell = (shell: 'sh' | 'bash' = 'sh') => (WINDOWS ? windowsBash() : shell)

/**
 * Spawn options for a process the runner stops as one with all it starts: a process group of its
 * own on macOS and Linux, its process tree on Windows (see above). No window on Windows.
 */
export const ownGroup = (): Pick<SpawnOptions, 'detached' | 'windowsHide'> =>
  WINDOWS ? { windowsHide: true } : { detached: true }

/**
 * Stop a process and all it started: the group it leads (SIGTERM by default), or on Windows its
 * process tree, at once (Windows has no signal a console program could take to end cleanly).
 */
export function stopTree(pid: number, signal: NodeJS.Signals = 'SIGTERM') {
  if (WINDOWS) {
    if (signal === ('SIGCONT' as NodeJS.Signals) || signal === ('SIGSTOP' as NodeJS.Signals)) return
    taskkill(pid)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // already gone
  }
}

/** Ends a process tree on Windows; resolves once taskkill is done. */
export function taskkill(pid: number) {
  return new Promise<void>((done) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => done())
  })
}

/**
 * Whether a process group (POSIX), or on Windows the process, is still running.
 */
export function groupAlive(pid: number) {
  try {
    process.kill(WINDOWS ? pid : -pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The name an environment gives its PATH: Windows' names are case-insensitive, and Node keeps
 * the one it was given (Path) when the environment is copied into an object. */
export const pathKey = (env: Record<string, string | undefined>) =>
  Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'

/** Folders put first on a PATH, once each (case-insensitively on Windows). */
export function prependPath(path: string | undefined, first: string[]) {
  const seen = new Set<string>()
  const key = (dir: string) => (WINDOWS ? dir.toLowerCase() : dir)
  return [...first, ...(path ?? '').split(delimiter)]
    .filter((dir) => dir && !seen.has(key(dir)) && seen.add(key(dir)))
    .join(delimiter)
}

/**
 * On Windows, at start: Git for Windows' git (cmd\) and Unix tools (usr\bin) first on the PATH,
 * and its bash for Claude Code's Bash tool, unless the person set one.
 */
export function useWindowsTools(env: NodeJS.ProcessEnv = process.env) {
  if (!WINDOWS) return
  const home = gitHome(env)
  if (!home) {
    console.warn('Git for Windows not found: commands and Claude Code will fail')
    return
  }
  const key = pathKey(env)
  env[key] = prependPath(env[key], [join(home, 'cmd'), join(home, 'usr', 'bin')])
  env.CLAUDE_CODE_GIT_BASH_PATH ??= join(home, 'bin', 'bash.exe')
  // GNU tar takes C:\… for a remote host's file unless told it is local.
  env.TAR_OPTIONS = [env.TAR_OPTIONS, '--force-local'].filter(Boolean).join(' ')
}

/** A Windows path as Git Bash writes it: C:\Users\a → /c/Users/a. Others as they are. */
export function toMsys(path: string) {
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(path)
  if (!drive) return path
  const rest = drive[2]!.replace(/\\/g, '/').replace(/\/+$/, '')
  return `/${drive[1]!.toLowerCase()}${rest ? `/${rest}` : ''}`
}

/**
 * A path from Git Bash, or from a teammate, as Windows takes it: /c/Users/a → C:\Users\a, /tmp
 * → the temporary folder, another POSIX path → in Git for Windows' folder, as its bash sees it.
 * Relative paths resolve from `cwd`. On macOS and Linux: resolved from `cwd`.
 */
export function toNative(path: string, cwd: string) {
  if (!WINDOWS) return resolve(cwd, path)
  const drive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(path)
  if (drive) return win32.normalize(`${drive[1]!.toUpperCase()}:\\${drive[2] ?? ''}`)
  if (/^\/tmp(?:\/|$)/.test(path)) return win32.join(tmpdir(), path.slice(4))
  if (path.startsWith('/') && !path.startsWith('//')) {
    const home = gitHome()
    if (home) return win32.join(home, path)
  }
  return isAbsolute(path) ? win32.normalize(path) : win32.resolve(cwd, path)
}

/** Spawn a shell script with the POSIX shell (see posixShell), hidden on Windows. */
export const spawnScript = (
  script: string,
  args: string[],
  options: SpawnOptions & { shell?: never },
  shell: 'sh' | 'bash' = 'sh',
) => spawn(posixShell(shell), ['-c', script, shell, ...args], { windowsHide: true, ...options })

/** Chrome on Windows, else Edge, which every Windows 11 has (preview checks, design renders). */
export const WINDOWS_CHROMES = WINDOWS
  ? [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].flatMap(
      (dir) =>
        dir
          ? [
              join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'),
              join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            ]
          : [],
    )
  : []

/** A relative path as the dashboard and git write it, with / (Windows' relative() gives \). */
export const slashes = (path: string) => (WINDOWS ? path.replace(/\\/g, '/') : path)
