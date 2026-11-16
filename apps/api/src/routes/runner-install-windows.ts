// The runner installer for Windows: install.sh's counterpart, in Windows PowerShell 5.1 (on every
// Windows 10 and 11), with the curl.exe and tar.exe Windows ships. No administrator, nothing for
// the person to install: Brigade.app runs it, and an updating runner runs it again, in the same two
// steps as install.sh (BRIGADE_INSTALL_STEP: stage, then swap).
//
// What differs from install.sh, and why:
// - Node.js and Git each go in a folder named after their version, and bin\node-path.txt and
//   bin\git-path.txt name the ones to use. Windows renames no folder whose program runs, and the
//   updating runner runs on the old Node while it installs: nothing in use is ever moved.
// - Git for Windows (PortableGit) comes with it: the runner runs its POSIX scripts with its sh,
//   and Claude Code needs its bash (CLAUDE_CODE_GIT_BASH_PATH).
// - The bundle's pnpm links become junctions (Windows makes no symbolic link without Developer
//   Mode or an administrator), from the list the bundle carries (runner/.symlinks). Junctions
//   hold absolute paths, so they are made once the runner is in its place, and folders that hold
//   them are removed with rmdir, which removes a junction and never what it points to.
// - The wrapper, bin\brigade-runner.cmd, is the same text in every version, since cmd.exe reads a
//   running script as it goes. Brigade.app starts node itself, not the wrapper (apps/desktop).
import { NODE_VERSION } from '@brigade/contracts'

/**
 * Git for Windows, pinned: PortableGit's self-extracting archive, by its SHA-256 as GitHub's
 * release lists it. GPLv2, downloaded from its own release on each computer, not redistributed.
 */
export const GIT_FOR_WINDOWS = {
  version: '2.56.1',
  tag: 'v2.56.1.windows.1',
  x64: {
    file: 'PortableGit-2.56.1-64-bit.7z.exe',
    sha256: '9dd04a608ceb5f6ab32a73709e0ecb159d211da71b697c45ff81f6dd0c6b49c7',
  },
  arm64: {
    file: 'PortableGit-2.56.1-arm64.7z.exe',
    sha256: '0dca0d9f760924a7e6752235d7dd6eb1a9b508ee714b6ed15d89252e5a58c5c9',
  },
} as const

/** Exit code of a runner that replaced itself: the wrapper starts the new one. */
const UPDATED_EXIT_CODE = 75

/** A PowerShell string literal. */
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`

/** The wrapper, for a person who runs the runner from a terminal (`brigade-runner start`). */
export const windowsWrapper = `@echo off
rem The Brigade runner. Exit code ${UPDATED_EXIT_CODE}: it updated itself; the new one starts.
setlocal
set "BRIGADE_SUPERVISED=1"
:run
set /p NODE=<"%~dp0node-path.txt"
"%NODE%" "%~dp0..\\runner\\dist\\index.js" %*
if %ERRORLEVEL% EQU ${UPDATED_EXIT_CODE} goto run
exit /b %ERRORLEVEL%
`

export const windowsInstallScript = (
  apiUrl: string,
) => `# Brigade runner installer for Windows. Installs into $env:BRIGADE_INSTALL_DIR, else
# %USERPROFILE%\\.brigade: Node.js, Git for Windows and the runner. No administrator needed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Api = ${literal(apiUrl)}
$NodeVersion = ${literal(NODE_VERSION)}
$NodeDist = if ($env:BRIGADE_NODE_DIST) { $env:BRIGADE_NODE_DIST } else { 'https://nodejs.org/dist' }
$GitDist = if ($env:BRIGADE_GIT_DIST) { $env:BRIGADE_GIT_DIST } else { 'https://github.com/git-for-windows/git/releases/download' }
$Dir = if ($env:BRIGADE_INSTALL_DIR) { $env:BRIGADE_INSTALL_DIR } elseif ($env:BRIGADE_HOME) { $env:BRIGADE_HOME } else { Join-Path $env:USERPROFILE '.brigade' }
$Step = if ($env:BRIGADE_INSTALL_STEP) { $env:BRIGADE_INSTALL_STEP } else { 'all' }
$Arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64'
$Arch = if ($Arm) { 'arm64' } else { 'x64' }
$Tar = Join-Path $env:SystemRoot 'System32\\tar.exe'
$Curl = Join-Path $env:SystemRoot 'System32\\curl.exe'
$Bin = Join-Path $Dir 'bin'
New-Item -ItemType Directory -Force -Path $Bin | Out-Null

function Get-Download([string]$Url, [string]$Out, [string]$Headers) {
  $Options = @('-fsSL', '--retry', '3', '-o', $Out)
  if ($Headers) { $Options += @('-D', $Headers) }
  & $Curl @Options $Url
  if ($LASTEXITCODE -ne 0) { throw "Could not download $Url" }
}
function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
function New-TempFolder {
  $T = Join-Path ([IO.Path]::GetTempPath()) ('brigade-' + [Guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $T | Out-Null
  $T
}
# Node's rmSync removes a junction itself, never what it points to (Remove-Item may empty its
# target), and takes paths past Windows' 260 characters, as pnpm's can be. Before Node is
# installed, rmdir, which also leaves what a junction points to.
function Remove-Folder([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if ($Node -and (Test-Path -LiteralPath $Node)) {
    & $Node -e "require('fs').rmSync(process.argv[1], { recursive: true, force: true, maxRetries: 10 })" $Path
  } else { cmd.exe /d /c "rmdir /s /q \`"$Path\`"" 2>$null | Out-Null }
}
# A rename, tried again for a while: an antivirus may hold a file just written.
function Rename-Folder([string]$From, [string]$To) {
  for ($i = 0; ; $i++) {
    try { Rename-Item -LiteralPath $From -NewName (Split-Path -Leaf $To); return }
    catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
# A small file, written whole: a reader never sees half of it.
function Set-Text([string]$Path, [string]$Text) {
  if ((Test-Path -LiteralPath $Path) -and [IO.File]::ReadAllText($Path) -eq $Text) { return }
  [IO.File]::WriteAllText("$Path.new", $Text)
  Move-Item -Force -LiteralPath "$Path.new" -Destination $Path
}
# Folders of other versions (node-v*, git-*), once nothing runs from them: a folder whose program
# runs cannot be renamed, so it stays until the next install.
function Remove-Others([string]$Pattern, [string]$Keep) {
  foreach ($Old in Get-ChildItem -LiteralPath $Dir -Directory -Filter $Pattern) {
    if ($Old.Name -eq $Keep -or $Old.Name -like '*.old') { continue }
    try { Rename-Item -LiteralPath $Old.FullName -NewName "$($Old.Name).old" } catch { continue }
    Remove-Folder "$($Old.FullName).old"
  }
  foreach ($Old in Get-ChildItem -LiteralPath $Dir -Directory -Filter "$Pattern.old") { Remove-Folder $Old.FullName }
}

# Node.js, checksum-verified, in a folder of its version.
$NodeName = "node-$NodeVersion-win-$Arch"
$NodeHome = Join-Path $Dir $NodeName
$Node = Join-Path $NodeHome 'node.exe'
if (-not (Test-Path -LiteralPath $Node)) {
  Write-Output "Installing Node.js $NodeVersion"
  $T = New-TempFolder
  $Zip = Join-Path $T "$NodeName.zip"
  Get-Download "$NodeDist/$NodeVersion/$NodeName.zip" $Zip
  Get-Download "$NodeDist/$NodeVersion/SHASUMS256.txt" (Join-Path $T 'SHASUMS256.txt')
  $Expected = $null
  foreach ($Line in Get-Content -LiteralPath (Join-Path $T 'SHASUMS256.txt')) {
    if ($Line -match '^([0-9a-f]{64})\\s+(\\S+)$' -and $Matches[2] -eq "$NodeName.zip") { $Expected = $Matches[1] }
  }
  if (-not $Expected -or $Expected -ne (Get-Sha256 $Zip)) { throw 'Node.js checksum mismatch' }
  $Unpack = Join-Path $Dir 'node.unpack'
  Remove-Folder $Unpack
  New-Item -ItemType Directory -Path $Unpack | Out-Null
  & $Tar -xf $Zip -C $Unpack
  if ($LASTEXITCODE -ne 0) { throw 'Could not unpack Node.js' }
  Remove-Folder $NodeHome
  Move-Item -LiteralPath (Join-Path $Unpack $NodeName) -Destination $NodeHome
  Remove-Folder $Unpack
  Remove-Item -Recurse -Force -LiteralPath $T
}

# Git for Windows (PortableGit): git, and the bash and sh the runner and Claude Code use.
$GitVersion = ${literal(GIT_FOR_WINDOWS.version)}
$GitName = "git-$GitVersion-$Arch"
$GitHome = Join-Path $Dir $GitName
if (-not (Test-Path -LiteralPath (Join-Path $GitHome 'bin\\bash.exe'))) {
  Write-Output "Installing Git for Windows $GitVersion"
  $GitFile = if ($Arm) { ${literal(GIT_FOR_WINDOWS.arm64.file)} } else { ${literal(GIT_FOR_WINDOWS.x64.file)} }
  $GitSha = if ($Arm) { ${literal(GIT_FOR_WINDOWS.arm64.sha256)} } else { ${literal(GIT_FOR_WINDOWS.x64.sha256)} }
  $T = New-TempFolder
  $Archive = Join-Path $T $GitFile
  Get-Download "$GitDist/${GIT_FOR_WINDOWS.tag}/$GitFile" $Archive
  if ((Get-Sha256 $Archive) -ne $GitSha) { throw 'Git for Windows checksum mismatch' }
  $Unpack = Join-Path $Dir 'git.unpack'
  Remove-Folder $Unpack
  # 7-Zip's self-extractor, without a window: -o the folder, -y no questions.
  $P = Start-Process -FilePath $Archive -ArgumentList @("-o\`"$Unpack\`"", '-y') -WindowStyle Hidden -Wait -PassThru
  if ($P.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $Unpack 'bin\\bash.exe'))) { throw 'Could not unpack Git for Windows' }
  # What PortableGit's first start does (git-bash.exe runs it): /etc set up for this folder.
  $PostInstall = Join-Path $Unpack 'post-install.bat'
  if (Test-Path -LiteralPath $PostInstall) {
    Push-Location $Unpack
    try { cmd.exe /d /c "post-install.bat" 2>&1 | Out-Null } finally { Pop-Location }
  }
  Remove-Folder $GitHome
  Rename-Folder $Unpack $GitHome
  Remove-Item -Recurse -Force -LiteralPath $T
}

# The runner, beside the running one (runner.new).
$Staged = Join-Path $Dir 'runner.new'
if ($Step -ne 'swap') {
  Write-Output 'Installing the Brigade runner'
  $T = New-TempFolder
  $Bundle = Join-Path $T 'runner.tgz'
  $Headers = Join-Path $T 'headers'
  Get-Download "$Api/runner/bundle.tgz" $Bundle $Headers
  $Expected = $null
  foreach ($Line in Get-Content -LiteralPath $Headers) {
    if ($Line -match '^x-bundle-sha256:\\s*([0-9a-f]+)') { $Expected = $Matches[1] }
  }
  $Actual = Get-Sha256 $Bundle
  if ($Expected -and $Expected -ne $Actual) { throw 'Runner bundle checksum mismatch' }
  Remove-Folder $Staged
  New-Item -ItemType Directory -Path $Staged | Out-Null
  # pnpm's links, listed in the bundle, are left out here and made junctions once in place.
  & $Tar -xzf $Bundle -C $T runner/.symlinks
  if ($LASTEXITCODE -ne 0) { throw 'The runner bundle has no list of its links (runner/.symlinks)' }
  $Links = @(Get-Content -LiteralPath (Join-Path $T 'runner\\.symlinks') | Where-Object { $_ })
  $Exclude = Join-Path $T 'exclude'
  [IO.File]::WriteAllLines($Exclude, [string[]]@($Links | ForEach-Object { 'runner/' + $_.Split("\`t")[0] }))
  & $Tar -xzf $Bundle -C $Staged --strip-components=1 -X $Exclude
  if ($LASTEXITCODE -ne 0) { throw 'Could not unpack the runner' }
  # The bundle a runner was installed from: it updates when the API serves another.
  [IO.File]::WriteAllText((Join-Path $Staged '.bundle-sha256'), "$Actual\`n")
  Remove-Item -Recurse -Force -LiteralPath $T
}
if ($Step -eq 'stage') { Write-Output "Staged $Staged"; exit 0 }
if (-not (Test-Path -LiteralPath (Join-Path $Staged '.bundle-sha256'))) { throw "No staged runner in $Staged" }

# Into place: the runner, then its junctions, then the files that name what to run.
$Runner = Join-Path $Dir 'runner'
Remove-Folder (Join-Path $Dir 'runner.old')
Remove-Folder (Join-Path $Bin 'shims')
if (Test-Path -LiteralPath $Runner) { Rename-Folder $Runner (Join-Path $Dir 'runner.old') }
Rename-Folder $Staged $Runner
# By Node, which takes long paths: a junction, unlike a symbolic link, needs no privilege.
& $Node -e @'
const fs = require('fs'), path = require('path')
const root = process.argv[1]
for (const line of fs.readFileSync(path.join(root, '.symlinks'), 'utf8').split('\\n')) {
  if (!line) continue
  const [link, target] = line.split('\\t')
  const at = path.join(root, link)
  fs.mkdirSync(path.dirname(at), { recursive: true })
  fs.symlinkSync(path.resolve(path.dirname(at), target), at, 'junction')
}
'@ $Runner
if ($LASTEXITCODE -ne 0) { throw 'Could not link the runner' }
Remove-Folder (Join-Path $Dir 'runner.old')
Set-Text (Join-Path $Bin 'node-path.txt') $Node
Set-Text (Join-Path $Bin 'git-path.txt') $GitHome
Set-Text (Join-Path $Bin 'brigade-runner.cmd') ${literal(windowsWrapper.replace(/\n/g, '\r\n'))}
Remove-Others 'node-v*' $NodeName
Remove-Others 'git-*' $GitName
Write-Output "Installed $(Join-Path $Bin 'brigade-runner.cmd')"
`
