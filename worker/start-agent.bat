@echo off
rem JSP Extender Control - start the local bridge agent (no window).
rem This delegates to start-agent-hidden.vbs so nothing flashes on screen.
rem You can also double-click start-agent-hidden.vbs directly.
cd /d "%~dp0"
wscript.exe "%~dp0start-agent-hidden.vbs"
