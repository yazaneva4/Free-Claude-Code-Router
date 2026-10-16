<# Ensure Git and Node.js 22+ are present before running the installer. #>
[CmdletBinding()]
param([string] $AppPath = $env:CCR_APP_PATH)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = if ($env:CCR_NODE) { $env:CCR_NODE } else { 'node' }
function Test-Node {
  if (-not (Get-Command $Node -ErrorAction SilentlyContinue)) { return $false }
  try {
    $version = & $Node -p "process.versions.node"
    return ([int]($version -split '\.')[0] -ge 22)
  } catch { return $false }
}
function Install-Dependency([string] $Id) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Missing $Id. Install it manually, or install Windows Package Manager (winget) and retry."
  }
  & winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "Failed to install $Id (exit $LASTEXITCODE)." }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Install-Dependency 'Git.Git'
}
if (-not (Test-Node)) {
  Install-Dependency 'OpenJS.NodeJS.LTS'
}
# winget upgrade is a no-op when the installed package is already current.
if ($env:CCR_SKIP_DEPENDENCY_UPDATE -ne '1' -and (Get-Command winget -ErrorAction SilentlyContinue)) {
  foreach ($Id in @('Git.Git', 'OpenJS.NodeJS.LTS')) {
    & winget upgrade --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Null
  }
}
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
if (-not (Test-Node)) { throw 'Node.js 22+ is unavailable after installation. Reopen PowerShell or install a supported version.' }
$Arguments = @((Join-Path $Root 'scripts\install.js'))
if ($AppPath) { $Arguments += @('--app-path', $AppPath) }
& $Node @Arguments
if ($LASTEXITCODE -ne 0) { throw "Installer failed with exit code $LASTEXITCODE" }
