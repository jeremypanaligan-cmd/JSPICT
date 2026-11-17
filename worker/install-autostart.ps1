# JSP Extender Control - install bridge autostart + silent watchdog.
#
# One-time setup on the PC that sits next to the Tapo plugs:
#   1. Startup shortcut: starts the agent at logon through wscript.exe +
#      start-agent-hidden.vbs, so no console window ever appears.
#   2. Scheduled task "JSP-Bridge-Watchdog" (opt out with -NoWatchdog): runs
#      run-watchdog.vbs through wscript.exe every 5 minutes. wscript is a GUI
#      process and it starts PowerShell with SW_HIDE, so no window is shown.
#
# Run it from this folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1 -NoWatchdog
#
# No administrator rights are needed: everything runs as the current user.

param([switch]$NoWatchdog)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $here 'start-agent-hidden.vbs'
$watchdog = Join-Path $here 'watchdog.ps1'
$watchdogLauncher = Join-Path $here 'run-watchdog.vbs'
$taskName = 'JSP-Bridge-Watchdog'

foreach ($required in @($launcher, (Join-Path $here 'bridge_agent.py'))) {
    if (-not (Test-Path $required)) {
        throw "Missing file: $required (run this script from the worker folder)"
    }
}
if (-not $NoWatchdog) {
    foreach ($required in @($watchdog, $watchdogLauncher)) {
        if (-not (Test-Path $required)) { throw "Missing file: $required" }
    }
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

# 2) Scheduled watchdog task (windowless: wscript -> hidden PowerShell) --
if ($NoWatchdog) {
    Write-Host 'Scheduled task   : skipped (-NoWatchdog)'
    Write-Host ''
    Write-Host 'Done. The agent starts silently at logon; the bridge worker starts only from the app.'
    return
}

$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
$taskAction = New-ScheduledTaskAction -Execute $wscriptExe `
    -Argument ('"{0}"' -f $watchdogLauncher) `
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
Write-Host "Scheduled task   : $taskName (every 5 minutes + at logon, windowless)"

# 3) Run one cycle now so a dead worker is fixed immediately ---------------
& $wscriptExe $watchdogLauncher
Start-Sleep -Seconds 8
Write-Host 'Watchdog         : first cycle started (see worker\watchdog.log)'
Write-Host ''
Write-Host 'Done. The agent starts at logon and the watchdog repairs the worker every 5 minutes.'
Write-Host "Undo: Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false   (and delete the Startup shortcut in shell:startup)"
