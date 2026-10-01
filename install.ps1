<#
.SYNOPSIS
  Installs this repository's build into the installed router app.

.DESCRIPTION
  The router app is not in this repository, so it has to be installed once
  first. This script finds it, packs this repository, and replaces the build it
  looks for. It only ever replaces one file, and it keeps the build it
  replaced.

  Windows has no code signature to break the way macOS does, so nothing is
  signed here. The app is installed by its own .exe installer, which puts it in
  a directory this script then finds.
#>

[CmdletBinding()]
param(
  [string] $AppPath = $env:CCR_APP_PATH
)

$ErrorActionPreference = 'Stop'
$AppName = 'Claude Code Router'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say([string] $message) { Write-Host $message }
function Die([string] $message) { Write-Error "error: $message"; exit 1 }

Say "platform: windows"

# --- find the installed router -------------------------------------------
# An NSIS install lands under LocalAppData\Programs, but a user can move it, so
# a few places are checked and the environment can point at it directly.
function Find-App {
  if ($AppPath -and (Test-Path $AppPath)) { return $AppPath }
  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Programs\$AppName") }
  $candidates += @("C:\Program Files\$AppName", "C:\Program Files (x86)\$AppName")
  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate 'resources')) { return $candidate }
  }
  return $null
}

$app = Find-App
if (-not $app) {
  Die "the $AppName app is not installed, and this repository layers on top of it.`n" +
      "Install it from https://github.com/musistudio/claude-code-router/releases (the .exe)`n" +
      'and run this again. Set CCR_APP_PATH if it is somewhere unusual.'
}
Say "app: $app"

$resources = Join-Path $app 'resources'
if (-not (Test-Path $resources)) { Die "could not find a resources directory inside $app" }
if (-not (Test-Path (Join-Path $resources 'app-original.asar'))) {
  Die "$resources\app-original.asar is missing, so this does not look like the router."
}

# --- a node to run the packer with ---------------------------------------
# The app's own binary can run as node, so nothing else has to be installed.
$exe = Join-Path $app "$AppName.exe"
$node = if ($env:CCR_NODE) { $env:CCR_NODE } elseif (Test-Path $exe) { $exe } else { 'node.exe' }
if (-not (Get-Command $node -ErrorAction SilentlyContinue) -and -not (Test-Path $node)) {
  Die "no usable binary to run the packer with. Install Node, or set CCR_NODE."
}
Say "packer: $node"

# --- pack and install ----------------------------------------------------
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("ccr-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  Say 'packing this repository'
  $env:ELECTRON_RUN_AS_NODE = '1'
  & $node (Join-Path $Root 'scripts\pack-asar.js') $Root (Join-Path $stage 'app.asar')
  if ($LASTEXITCODE -ne 0) { Die "packing failed with exit code $LASTEXITCODE" }

  $target = Join-Path $resources 'app.asar'
  $backup = Join-Path $resources 'app.asar.before-gate'
  if ((Test-Path $target) -and -not (Test-Path $backup)) {
    Copy-Item $target $backup
    Say "kept the build it replaced at $backup"
  }

  # Copied beside the target and moved over it, so an interrupted install
  # cannot leave a half written build where the app expects a whole one.
  $temp = Join-Path $resources 'app.asar.new'
  Copy-Item (Join-Path $stage 'app.asar') $temp
  Move-Item -Force $temp $target
  Say "installed into $target"
}
finally {
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}

Say ''
Say 'done. Open the app and it will use this build.'
Say "  `"$exe`""
