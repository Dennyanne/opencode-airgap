# Spike 1 — Windows host run script
# Requires: Bun installed (winget install oven-sh.bun), internet access on BUILD machine only.
# Run this script on a WINDOWS x64 machine.
#
# What it does:
#   1. Ensures payload/dummy-bin.exe exists (copies where.exe as a harmless test binary).
#   2. Compiles entry.ts targeting bun-windows-x64.
#   3. Runs the resulting .exe and prints PASS or FAIL.
#
# PASS criteria: exe runs, extracts dummy-bin.exe, spawns it, exit 0, output printed.
# FAIL criteria: crash, hang, or non-zero exit => #10344 reproduced, escalate.
#
# If blocked by execution policy, run:
#   powershell -ExecutionPolicy Bypass -File .\run.ps1

# Self-re-invoke with Bypass if the current process policy would block us.
if ((Get-ExecutionPolicy -Scope Process) -notin @('Bypass', 'Unrestricted')) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $MyInvocation.MyCommand.Path @args
    exit $LASTEXITCODE
}

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

Write-Host "==================================================="
Write-Host " Spike 1 — Bun embed-spawn (Windows host)"
Write-Host "==================================================="

# --- Prepare dummy payload ---
$PayloadDir = Join-Path $ScriptDir "payload"
$PayloadPath = Join-Path $PayloadDir "dummy-bin.exe"

if (-Not (Test-Path $PayloadDir)) {
    New-Item -ItemType Directory -Path $PayloadDir | Out-Null
}

if (-Not (Test-Path $PayloadPath)) {
    # Use where.exe as a harmless small native Windows binary
    $whereExe = "$env:SystemRoot\System32\where.exe"
    if (Test-Path $whereExe) {
        Copy-Item $whereExe $PayloadPath
        Write-Host "Copied where.exe -> $PayloadPath (dummy payload)"
    } else {
        Write-Error "Cannot find where.exe at $whereExe. Supply a small .exe at $PayloadPath and re-run."
    }
}

# --- NOTE: entry.ts imports ./payload/dummy-bin (no .exe extension).
# --- On Windows the file must be named dummy-bin (Bun resolves by exact name).
# --- Copy to the extensionless name Bun expects.
$PayloadNaked = Join-Path $PayloadDir "dummy-bin"
if (-Not (Test-Path $PayloadNaked)) {
    Copy-Item $PayloadPath $PayloadNaked
    Write-Host "Also placed extensionless copy: $PayloadNaked"
}

# --- Compile for windows-x64 ---
$DistDir = Join-Path $ScriptDir "dist"
if (-Not (Test-Path $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir | Out-Null
}
$OutExe = Join-Path $DistDir "spike1-windows.exe"

Write-Host ""
Write-Host "Compiling entry.ts -> $OutExe ..."
bun build --compile --target=bun-windows-x64 --outfile $OutExe "$ScriptDir\entry.ts"

Write-Host ""
Write-Host "Running $OutExe ..."
& $OutExe
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "FINAL VERDICT: PASS (exit 0)"
} else {
    Write-Host "FINAL VERDICT: FAIL (exit $exitCode) -- check output above for crash details"
    Write-Host "  => If crashed/hung, Bun#10344 is reproduced. Escalate Option A risk to user."
    exit $exitCode
}
