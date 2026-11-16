# JSP Extender Control - bridge watchdog.
#
# Run every few minutes by the "JSP-Bridge-Watchdog" scheduled task.
# Checks, in order:
#   1. Is the local bridge agent (bridge_agent.py, port 8765) answering?
#      If not, start it (pythonw.exe, hidden).
#   2. Is the bridge worker process alive (agent reports a live pid)?
#      If not, ask the agent to start it.
# Everything is written to worker/watchdog.log; a healthy cycle writes nothing.
#
# ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI.

$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logFile = Join-Path $here 'watchdog.log'
$origin = 'https://jeremypanaligan-cmd.github.io'
$port = if ($env:BRIDGE_AGENT_PORT) { $env:BRIDGE_AGENT_PORT } else { '8765' }
$base = "http://127.0.0.1:$port"

function Write-Log([string]$message) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $logFile -Value "$stamp | $message" -Encoding UTF8
}

# Keep the log small: rotate once it passes 1 MB.
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 1MB)) {
    Move-Item -Path $logFile -Destination "$logFile.old" -Force
}

function Get-AgentStatus {
    try {
        return Invoke-RestMethod -Uri "$base/status" -TimeoutSec 4
    } catch {
        return $null
    }
}

function Start-Agent {
    $script = Join-Path $here 'bridge_agent.py'
    $pythonw = Join-Path $here '.venv\Scripts\pythonw.exe'
    if (-not (Test-Path $script)) {
        Write-Log "bridge_agent.py is missing next to watchdog.ps1 ($here)"
        return
    }
    if (-not (Test-Path $pythonw)) { $pythonw = 'pythonw.exe' }

    # The script path usually contains spaces, so it must be quoted.
    try {
        $proc = Start-Process -FilePath $pythonw -ArgumentList ('"{0}"' -f $script) `
            -WorkingDirectory $here -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 3
        if ($proc -and $proc.HasExited) {
            Write-Log "Agent process exited immediately (code $($proc.ExitCode)): $pythonw $script"
        }
    } catch {
        Write-Log "Could not start the agent: $($_.Exception.Message)"
    }
}

$status = Get-AgentStatus
if (-not $status) {
    Write-Log 'Agent not answering - starting bridge_agent.py'
    Start-Agent
    Start-Sleep -Seconds 2
    $status = Get-AgentStatus
}

if (-not $status) {
    Write-Log 'Agent still not answering after a start attempt; will retry next cycle'
    exit 1
}

if ($status.running) {
    exit 0
}

Write-Log "Worker is not running - starting it via the agent (reported pid: $($status.pid))"
try {
    $result = Invoke-RestMethod -Uri "$base/start" -Method Post -TimeoutSec 25 `
        -Headers @{ Origin = $origin } -ContentType 'text/plain'
    if ($result.running) {
        Write-Log "Worker started (pid $($result.pid))"
        exit 0
    }
    Write-Log "Worker start returned running=false: $($result.error)"
    exit 1
} catch {
    Write-Log "Worker start failed: $($_.Exception.Message)"
    exit 1
}
