# Spike 3 — Windows host run script (Node-LSP runtime decision)
# Requires: Bun + Node installed on the Windows machine, tsserver available.
# This script mirrors run.sh but runs on Windows.
#
# PASS/FAIL: see README.md for criteria.
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
# Note: nest two 2-argument Join-Path calls — passing 3+ positional args to
# Join-Path is PowerShell 7+ only and fails under Windows PowerShell 5.1.
$RepoRoot = (Resolve-Path (Join-Path (Join-Path $ScriptDir "..") "..")).Path

Write-Host "==================================================="
Write-Host " Spike 3 — Node-LSP runtime decision (Windows)"
Write-Host "==================================================="

# Locate tsserver. Check the actual JS entry the LSP probe runs below
# (node_modules\typescript\bin\tsserver), not a node_modules\.bin shim —
# bun does not reliably create a .bin\tsserver(.cmd) shim on Windows.
$TsServer = Join-Path $RepoRoot "node_modules\typescript\bin\tsserver"
if (-Not (Test-Path $TsServer)) {
    Write-Error "tsserver not found at $TsServer. Run: cd $RepoRoot; bun install"
}

# Note: avoid the `?.` null-conditional operator here — it is PowerShell 7.1+
# only, and run scripts re-invoke through Windows PowerShell 5.1 (powershell.exe).
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$BunCmd  = Get-Command bun  -ErrorAction SilentlyContinue
$NodeBin = if ($NodeCmd) { $NodeCmd.Source } else { $null }
$BunBin  = if ($BunCmd)  { $BunCmd.Source }  else { $null }

if (-Not $NodeBin) { Write-Error "node not found in PATH" }
if (-Not $BunBin)  { Write-Error "bun not found in PATH" }

Write-Host "  tsserver : $TsServer"
Write-Host "  node     : $NodeBin ($(& node --version))"
Write-Host "  bun      : $BunBin ($(& bun --version))"
Write-Host ""

# LSP initialize payload (Content-Length framed)
$Body = '{"seq":1,"type":"request","command":"initialize","arguments":{"processId":' + $PID + ',"rootPath":"C:\\Temp","capabilities":{},"hostInfo":"spike3-harness"}}'
$BodyBytes = [System.Text.Encoding]::UTF8.GetByteCount($Body)
$Payload = "Content-Length: $BodyBytes`r`n`r`n$Body"

function Try-LSP {
    param([string]$Label, [string]$Runtime)

    Write-Host "--- Testing: $Label ---"
    Write-Host "  runtime: $Runtime"

    $TsServerJs = Join-Path $RepoRoot "node_modules\typescript\bin\tsserver"

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Runtime
    # Pass tsserver path as argument (Bun runs JS files directly)
    $psi.Arguments = "`"$TsServerJs`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    # tsserver is a long-running server — it never closes stdout, so a
    # synchronous Peek()/ReadToEnd() blocks forever. Instead read output
    # asynchronously into a StringBuilder via an event handler (never blocks)
    # and also drain stderr so its pipe buffer cannot fill and deadlock the
    # child. We then poll the buffer until a framed response appears or a hard
    # 10s deadline elapses, and kill the process regardless.
    $sb = New-Object System.Text.StringBuilder
    $outEvent = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -MessageData $sb -Action {
        if ($null -ne $EventArgs.Data) { [void]$Event.MessageData.AppendLine($EventArgs.Data) }
    }
    $errEvent = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {}

    [void]$proc.Start()
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    # Send the initialize request.
    $proc.StandardInput.Write($Payload)
    $proc.StandardInput.Flush()

    # Poll the async buffer (non-blocking) until framed response or timeout.
    $read = $false
    $response = ""
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        try { $response = $sb.ToString() } catch { Start-Sleep -Milliseconds 50; continue }
        if ($response -match "Content-Length") { $read = $true; break }
        if ($proc.HasExited) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $read) { try { $response = $sb.ToString() } catch { $response = "" } }

    # Tear down: stop the process and remove the event subscriptions.
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
    Unregister-Event -SourceIdentifier $outEvent.Name -ErrorAction SilentlyContinue
    Unregister-Event -SourceIdentifier $errEvent.Name -ErrorAction SilentlyContinue
    try { $proc.Dispose() } catch { }

    if ($read -and $response -match "Content-Length") {
        $previewLen = [Math]::Min($response.Length, 120)
        Write-Host "  response bytes : $($response.Length)"
        Write-Host "  first chars    : $($response.Substring(0, $previewLen))"
        Write-Host "  verdict        : PASS"
        return $true
    } else {
        Write-Host "  verdict        : FAIL (no LSP-framed response within 10s)"
        return $false
    }
}

$nodePass = Try-LSP "Node (control)" $NodeBin
Write-Host ""
$bunPass  = Try-LSP "Bun (candidate)" $BunBin

Write-Host ""
Write-Host "==================================================="
Write-Host " RESULTS"
Write-Host "==================================================="
Write-Host "  Node hosting tsserver : $(if ($nodePass) { 'PASS' } else { 'FAIL' })"
Write-Host "  Bun  hosting tsserver : $(if ($bunPass)  { 'PASS' } else { 'FAIL' })"
Write-Host ""

if ($bunPass) {
    Write-Host "DECISION: bun-host"
    Write-Host "  Bun can directly host tsserver on Windows."
} else {
    Write-Host "DECISION: embed-node"
    if ($nodePass) {
        Write-Host "  Node hosts tsserver but Bun cannot. Embed portable Node."
    } else {
        Write-Host "  Neither runtime succeeded. Check tsserver install. Default: embed-node."
    }
}
