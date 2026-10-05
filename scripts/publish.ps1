#!/usr/bin/env pwsh
<#
  Publishes dsh-550w-boot: runs the assertions, commits, pushes main to GitHub
  and publishes to npm.

      .\scripts\publish.ps1 -RepoUrl https://github.com/<owner>/dsh-550w-boot.git

  The first push asks GitHub for permission through Git Credential Manager (one
  browser window); `npm publish` needs `npm login` done once beforehand.
#>
param(
  [Parameter(Mandatory = $true)][string]$RepoUrl,
  [string]$Message = "release: dsh-550w-boot 1.0.0"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { $git = "C:\Program Files\Git\cmd\git.exe" }
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = "D:\app\nodejs\npm.cmd" }

Write-Host "== assertions ==" -ForegroundColor Cyan
node test/render.test.mjs

Write-Host "== git ==" -ForegroundColor Cyan
if (-not (Test-Path .git)) {
  & $git init -b main
  & $git config user.name "m550w"
  & $git config user.email "m550w@users.noreply.github.com"
}
& $git add -A
if (& $git status --porcelain) { & $git commit -m $Message }
& $git remote remove origin 2>$null
& $git remote add origin $RepoUrl
& $git push -u origin main

Write-Host "== npm ==" -ForegroundColor Cyan
& $npm publish --access public

Write-Host ""
Write-Host "Still to do by hand on github.com -> Settings:" -ForegroundColor Yellow
Write-Host "  topics: dsh-plugin, dsh, deepseek-harness, splash-screen, 550w, moss, stellaris"
