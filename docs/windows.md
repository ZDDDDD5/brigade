# Teammates on Windows

Brigade.app for Windows runs teammates on a member's own PC, natively: no WSL, no terminal, nothing for the person
to install but `Brigade-Setup.exe`. One runner codebase serves macOS, Linux and Windows; where Windows differs, the
runner goes through `apps/runner/src/windows.ts`.

## Install and update

- **Brigade.app** (`apps/desktop/src/runner.ts`) downloads the API's `install.ps1` (`apps/api/src/routes/
runner-install-windows.ts`) to a file and runs it with Windows PowerShell 5.1, which every Windows 10 and 11 has,
  as the person (no administrator).
- **install.ps1** puts into `%USERPROFILE%\.brigade`, with the `curl.exe` and `tar.exe` Windows ships:
  - Node.js (`NODE_VERSION`, the zip checksum-verified against nodejs.org's SHASUMS256) in `node-<version>-win-<arch>`;
  - Git for Windows (PortableGit, pinned with its SHA-256 in `GIT_FOR_WINDOWS`) in `git-<version>-<arch>`: git, and
    the bash the runner's POSIX scripts and Claude Code run in. GPLv2, downloaded from its own GitHub release on
    each computer, not redistributed. About 60 MB to download, 350 MB unpacked;
  - the runner bundle (checked against `x-bundle-sha256`), in `runner`.
    `bin\node-path.txt` and `bin\git-path.txt` name the Node and Git to use. Versions live in folders of their own,
    since Windows renames no folder whose program runs, and an updating runner runs on the old Node while it installs.
- **pnpm's links**: the bundle's `node_modules` holds pnpm's symbolic links, which Windows makes only with Developer
  Mode or an administrator. `bundle.sh` lists them in `runner/.symlinks`; install.ps1 extracts the bundle without
  them and makes a junction for each once the runner is in its place (junctions hold absolute paths). Folders that
  hold junctions are removed with Node's `rmSync` (or `rmdir`), which removes a junction, never what it points to.
- **Updates** are install.sh's two steps (stage, then swap). The runner runs install.ps1 itself
  (`apps/runner/src/updater.ts`), then exits 75; Brigade.app starts the new one at once.
- **Starting and stopping**: Brigade.app starts `node runner\dist\index.js start` itself, hidden, with an IPC
  channel, rather than the wrapper (`bin\brigade-runner.cmd`, for a terminal). Windows has no SIGTERM: the app sends
  `brigade:stop` over the channel, the runner saves its turns as on SIGTERM, and the app ends its process tree
  (`taskkill /T /F`) after a minute. When the app goes, the runner goes too (Node's job object), and a channel that
  closes stops it the same way.
- **At login**: Brigade.app opens at login (Electron's login item), turned on once when this version first runs.

## The runner on Windows (windows.ts)

- **Shell**: Git for Windows' `cmd\` (git) and `usr\bin` (sh, bash, find, head, GNU tar…) come first on the
  runner's PATH, so the runner's own `sh -c` scripts and its `find`, `cat` or `tar` calls run as on Linux, before
  Windows' own `find`, `sort` and `tar`, which are other programs. Claude Code's Bash tool uses the same bash
  (`CLAUDE_CODE_GIT_BASH_PATH`).
- **Paths**: the harnesses (`@ai-sdk/harness`) handle sandbox paths with `path.posix`. The local sandbox gives them
  Git Bash's paths (`/c/Users/…`) and turns them back into Windows paths for file operations (`toNative`); bash turns
  them into Windows paths for the Windows programs it starts (node, the bridges). Paths that go to the dashboard
  are written with `/` (`slashes`).
- **Processes**: no process groups. A turn, a preview or a goal command is stopped with its process tree
  (`stopTree`, `taskkill /T /F`), at once: Windows has no signal a console program could take to end cleanly.
  Nothing is detached: a detached process has no console, and every console program it starts would open a window.
  Leftovers of a runner that died are found from Windows' process list (`Get-CimInstance Win32_Process`).
- **The vendor CLIs** (`apps/runner/src/vendor-cli.ts`): signing in needs `claude` or `codex`, which the people
  Brigade runs for on Windows rarely have. The first sign-in installs the harnesses' own copy, in the folder their
  bootstrap uses (`~/.ai-sdk-harness/.harness-bootstrap/<harness>`), with the same files and `pnpm install`, so a
  turn's bootstrap finds it there and nothing is downloaded twice.
- **Instructions**: teammates are told they are on Windows (`windowsComputer` in `instructions.ts`): Git Bash for
  Claude Code, PowerShell for Codex, Windows paths for Brigade's tools, line endings, what Linux has and Windows
  lacks.

## Isolation

On a cloud computer each teammate is a Linux user of its own (`CLOUD`, sudo). Windows has none of that: teammates
run as the person's own Windows account, as Claude Code or Codex do when the person runs them, and can read and
change what that account can. Brigade asks before it links the computer, and says so.

## What is degraded or missing on Windows

- **Computer use**: macOS only (Brigade Computer Use.app). Off on Windows, as on Linux.
- **Previews**: they start, are proxied and stop. An unused one is not paused (no SIGSTOP), and none is measured or
  held in a cgroup (Linux only). An update of the runner restarts the previews running then, rather than handing
  them over.
- **Turns during an update**: the turns running then are continued from their conversation after the restart, as
  for Pi, rather than handed over live: the shell that leads a harness ends with the runner, and its processes can't
  be followed across a restart.
- **Port holders**: "who holds this port" (`port-holders.ts`, lsof) says nothing on Windows.
- **Docker**: a teammate uses the `docker` of Docker Desktop if the person installed it; Brigade sets nothing up.
- **Terminals** (take control): cloud computer only, as on a Mac.

## Tests

CI's Windows job (`.github/workflows/ci.yml`) runs the runner's tests but those `apps/runner/test/
not-on-windows.txt` lists (what the runner does only on Linux or macOS), install.ps1 for real
(`apps/api/test/runner-install-windows.test.ts`), and Brigade.app's typecheck and tests
(`apps/desktop/test/runner-windows.test.ts` for the supervisor).
