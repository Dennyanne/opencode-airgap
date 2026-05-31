# Spike 2 — Windows host run script
# Requires: Bun installed, curl or Invoke-WebRequest available.
# Run this on a WINDOWS x64 machine.
#
# PASS criteria:
#   - java -version prints a JRE 21 version string (exit 0)
#   - Extraction time <= 60 000 ms
# FAIL criteria: extraction error, java not found, or time > 60s.
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
Write-Host " Spike 2 — JRE embed/extract (Windows host)"
Write-Host "==================================================="

# --- Step 1: Download JRE if not present ---
$PayloadDir = Join-Path $ScriptDir "payload"
if (-Not (Test-Path $PayloadDir)) {
    New-Item -ItemType Directory -Path $PayloadDir | Out-Null
}

$JreZip = Join-Path $PayloadDir "jre21.zip"
if (-Not (Test-Path $JreZip)) {
    $AdoptiumUrl = "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse"
    Write-Host "Downloading Temurin JRE 21 (windows/x64) ..."
    Write-Host "  URL: $AdoptiumUrl"
    Write-Host "  -> $JreZip"
    Invoke-WebRequest -Uri $AdoptiumUrl -OutFile $JreZip -UseBasicParsing
    $sizeMB = [math]::Round((Get-Item $JreZip).Length / 1MB, 1)
    Write-Host "  Downloaded: ${sizeMB} MB"
} else {
    $sizeMB = [math]::Round((Get-Item $JreZip).Length / 1MB, 1)
    Write-Host "JRE already present: $JreZip (${sizeMB} MB)"
}

# --- Step 2: Compile ---
$DistDir = Join-Path $ScriptDir "dist"
if (-Not (Test-Path $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir | Out-Null
}
$OutExe = Join-Path $DistDir "spike2-windows.exe"

Write-Host ""
Write-Host "Compiling entry.ts -> $OutExe ..."
bun build --compile --target=bun-windows-x64 --outfile $OutExe "$ScriptDir\entry.ts"

Write-Host ""
Write-Host "Running $OutExe ..."
& $OutExe
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "FINAL VERDICT: PASS"
} else {
    Write-Host "FINAL VERDICT: FAIL (exit $exitCode)"
    exit $exitCode
}
