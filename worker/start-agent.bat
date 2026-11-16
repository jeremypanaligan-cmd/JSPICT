@echo off
rem JSP Extender Control - start the local bridge agent (lets the app start the bridge).
rem Optional: copy this file into shell:startup so the agent is always available.
cd /d "%~dp0"

if exist ".venv\Scripts\pythonw.exe" (
  start "" ".venv\Scripts\pythonw.exe" bridge_agent.py
) else (
  start "" pythonw bridge_agent.py
)
