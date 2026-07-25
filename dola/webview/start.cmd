@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [dola-webview] creating venv...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -U pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

echo [dola-webview] starting launcher...
start "" ".venv\Scripts\pythonw.exe" launcher.py
if errorlevel 1 (
  ".venv\Scripts\python.exe" launcher.py
)
endlocal
