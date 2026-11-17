' JSP Extender Control - start the bridge agent with no window at all.
' Double-click this file (or a shortcut to it) whenever the app says
' "No local agent" and you want the Start bridge button to work.
'
' wscript.exe is a GUI process, so nothing flashes like a CMD window.

Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

pythonw = here & "\.venv\Scripts\pythonw.exe"
If Not fso.FileExists(pythonw) Then pythonw = "pythonw.exe"

script = here & "\bridge_agent.py"
If Not fso.FileExists(script) Then
    MsgBox "bridge_agent.py was not found next to this file.", 16, "JSP Bridge Agent"
    WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = here
shell.Run """" & pythonw & """ """ & script & """", 0, False
