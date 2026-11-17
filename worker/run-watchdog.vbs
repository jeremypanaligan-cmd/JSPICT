' JSP Extender Control - run watchdog.ps1 with no visible window.
'
' The scheduled task calls wscript.exe on this file. wscript is a GUI process,
' and it starts PowerShell with window style 0 (SW_HIDE), so the console window
' is never shown - not even for a frame.

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = here & "\watchdog.ps1"
If Not fso.FileExists(script) Then WScript.Quit 1

systemRoot = shell.ExpandEnvironmentStrings("%SystemRoot%")
powershell = systemRoot & "\System32\WindowsPowerShell\v1.0\powershell.exe"

shell.CurrentDirectory = here
shell.Run """" & powershell & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
