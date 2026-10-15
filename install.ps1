<# Windows PowerShell terminal entry point. Requires Node.js 22+. #>
[CmdletBinding()]
param([string] $AppPath = $env:CCR_APP_PATH)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = if ($env:CCR_NODE) { $env:CCR_NODE } else { 'node' }
if (-not (Get-Command $Node -ErrorAction SilentlyContinue)) {
  throw 'Install Node.js 22 or newer, then run this command again.'
}
$Arguments = @((Join-Path $Root 'scripts\install.js'))
if ($AppPath) { $Arguments += @('--app-path', $AppPath) }
& $Node @Arguments
if ($LASTEXITCODE -ne 0) { throw "Installer failed with exit code $LASTEXITCODE" }
