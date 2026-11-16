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
 * Resolves once it is done (at once on macOS and Linux).
 */
export function stopTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (WINDOWS) {
    if (signal === ('SIGCONT' as NodeJS.Signals) || signal === ('SIGSTOP' as NodeJS.Signals))
      return Promise.resolve()
    return windowsTree(pid).then(
      (pids) => kill(pids),
      () => taskkill(pid),
    )
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // already gone
  }
  return Promise.resolve()
}

/** Ends a process tree on Windows, as Windows sees it (taskkill /T); resolves once done. */
export function taskkill(pid: number) {
  return new Promise<void>((done) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => done())
  })
}

/** Ends processes on Windows, at once. */
const kill = async (pids: number[]) => {
  for (let i = 0; i < pids.length; i += 50)
    await new Promise<void>((done) =>
      execFile(
        'taskkill',
        ['/F', ...pids.slice(i, i + 50).flatMap((pid) => ['/PID', String(pid)])],
        { windowsHide: true },
        () => done(),
      ),
    )
}

/** Every process, as Windows lists them: pid, parent pid, seconds running. */
export async function windowsProcesses() {
  const stdout = await new Promise<string>((done, fail) =>
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $([int64]((Get-Date) - $_.CreationDate).TotalSeconds) $($_.Name)" }',
      ],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, out) => (error ? fail(error) : done(out)),
    ),
  )
  return parseWindowsList(stdout)
}

/** Lines of "pid ppid seconds-running name". */
export function parseWindowsList(text: string) {
  const procs: { pid: number; ppid: number; seconds: number; name?: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, seconds, ...name] = line.trim().split(/\s+/)
    const [p, pp, sec] = [pid, ppid, seconds].map(Number)
    if (!Number.isInteger(p) || !Number.isInteger(pp) || !Number.isFinite(sec)) continue
    procs.push({
      pid: p!,
      ppid: pp!,
      seconds: sec!,
      ...(name.length ? { name: name.join(' ') } : {}),
    })
  }
  return procs
}

/** Git Bash's own processes (`ps -l`): its pid, process group and Windows pid. */
export function parseMsysList(text: string) {
  const procs: { pid: number; pgid: number; winpid: number }[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[A-Z]?\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(line)
    if (match) procs.push({ pid: +match[1]!, pgid: +match[3]!, winpid: +match[4]! })
  }
  return procs
}

/**
 * What a process started, on Windows. Windows' parent pids miss what Git Bash forks (a command
 * run with &, a subshell): its parent there is a process Git Bash made and ended. So: the process,
 * what Windows says it started, the Git Bash process groups of all those, what those groups hold,
 * and what they started in turn, until nothing new comes.
 */
export async function windowsTree(
  root: number,
  ps = join(gitHome() ?? '', 'usr', 'bin', 'ps.exe'),
) {
  const [procs, msys] = await Promise.all([
    windowsProcesses(),
    new Promise<string>((done) =>
      execFile(ps, ['-l'], { windowsHide: true }, (_error, out) => done(out ?? '')),
    ).then(parseMsysList),
  ])
  return treeOf(root, procs, msys)
}

/** The harnesses' CLIs, and the shells they run a command in. */
const HARNESS_CLI = /^(codex|claude)\.exe$/i
const COMMAND_SHELL = /^(powershell|pwsh|cmd|bash|sh)\.exe$/i

/**
 * The commands a harness runs now, under these process trees (a sandbox's): each shell a harness's
 * CLI started (Codex's PowerShell, Claude Code's bash) with what it started, and none of the CLI's
 * other children (its MCP servers, Codex's code-mode host), which its session keeps. Codex on
 * Windows leaves a command running when its turn is interrupted: these are what to end then.
 */
export function commandsOf(
  roots: number[],
  procs: { pid: number; ppid: number; name?: string }[],
  msys: { pgid: number; winpid: number }[],
) {
  const under = new Set<number>()
  for (const root of roots) for (const pid of treeOf(root, procs, msys)) under.add(pid)
  const clis = new Set(
    procs.filter((p) => under.has(p.pid) && HARNESS_CLI.test(p.name ?? '')).map((p) => p.pid),
  )
  const found = new Set<number>()
  for (const shell of procs)
    if (clis.has(shell.ppid) && COMMAND_SHELL.test(shell.name ?? ''))
      for (const pid of treeOf(shell.pid, procs, msys)) found.add(pid)
  return [...found]
}

/** Windows: ends the commands harnesses run under these trees (commandsOf). */
export async function stopCommands(
  roots: number[],
  ps = join(gitHome() ?? '', 'usr', 'bin', 'ps.exe'),
) {
  if (!WINDOWS || roots.length === 0) return
  const [procs, msys] = await Promise.all([
    windowsProcesses(),
    new Promise<string>((done) =>
      execFile(ps, ['-l'], { windowsHide: true }, (_error, out) => done(out ?? '')),
    ).then(parseMsysList),
  ])
  const pids = commandsOf(roots, procs, msys)
  if (pids.length) await kill(pids)
}

export function treeOf(
  root: number,
  procs: { pid: number; ppid: number }[],
  msys: { pgid: number; winpid: number }[],
) {
  const found = new Set([root])
  const groups = new Set<number>()
  for (let grew = true; grew;) {
    grew = false
    for (const p of procs)
      if (found.has(p.ppid) && !found.has(p.pid) && p.pid !== process.pid) {
        found.add(p.pid)
        grew = true
      }
    for (const m of msys) if (found.has(m.winpid)) groups.add(m.pgid)
    for (const m of msys)
      if (groups.has(m.pgid) && !found.has(m.winpid) && m.winpid !== process.pid) {
        found.add(m.winpid)
        grew = true
      }
  }
  // The deepest first: none starts again what an ended parent left.
  return [...found].reverse()
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
