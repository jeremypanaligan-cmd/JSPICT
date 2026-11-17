# JSP Extender Control - install bridge autostart (and optionally the watchdog).
#
# One-time setup on the PC that sits next to the Tapo plugs:
#   1. Puts a shortcut in the Startup folder that starts the agent at logon.
#      It runs wscript.exe + start-agent-hidden.vbs, so NO console window ever
#      appears (no cmd.exe flash).
#   2. Only with -WithWatchdog: registers the "JSP-Bridge-Watchdog" scheduled
#      task, which runs watchdog.ps1 every 5 minutes. That task opens a short
#      PowerShell window each cycle, so it is off by default.
#
# Run it from this folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1 -WithWatchdog
#
# No administrator rights are needed: everything runs as the current user.

param([switch]$WithWatchdog)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $here 'start-agent-hidden.vbs'
$watchdog = Join-Path $here 'watchdog.ps1'
$taskName = 'JSP-Bridge-Watchdog'

foreach ($required in @($launcher, (Join-Path $here 'bridge_agent.py'))) {
    if (-not (Test-Path $required)) {
        throw "Missing file: $required (run this script from the worker folder)"
    }
}
if ($WithWatchdog -and -not (Test-Path $watchdog)) {
    throw "Missing file: $watchdog (needed for -WithWatchdog)"
}

# 1) Startup shortcut ------------------------------------------------------
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'JSP Bridge Agent.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = (Join-Path $env:SystemRoot 'System32\wscript.exe')
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $here
$shortcut.WindowStyle = 7          # wscript has no window anyway
$shortcut.Description = 'Start the JSP Extender bridge agent at logon'
$shortcut.Save()
Write-Host "Startup shortcut : $shortcutPath"

# 2) Optional scheduled watchdog task -------------------------------------
if (-not $WithWatchdog) {
    Write-Host 'Scheduled task   : skipped (add -WithWatchdog if you want the 5-minute repair)'
    Write-Host ''
    Write-Host 'Done. The agent starts silently at logon; the bridge worker starts only from the app.'
    Write-Host 'Remove later: delete the Startup shortcut (shell:startup).'
    return
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskAction = New-ScheduledTaskAction -Execute $powershell `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $watchdog) `
    -WorkingDirectory $here

# Every 5 minutes, plus one run right after logon.
$repeating = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $taskName -Action $taskAction `
    -Trigger @($repeating, $atLogon) -Settings $taskSettings -Force | Out-Null
Write-Host "Scheduled task   : $taskName (every 5 minutes + at logon)"

# 3) Run one cycle now so a dead worker is fixed immediately ---------------
& $powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $watchdog
Write-Host 'Watchdog         : first cycle finished (see worker\watchdog.log)'
Write-Host ''
Write-Host 'Done. The agent starts at logon and the watchdog repairs the worker every 5 minutes.'
Write-Host "Undo: Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false   (and delete the Startup shortcut)"
