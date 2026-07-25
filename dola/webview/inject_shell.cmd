@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv 2>nul || python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

set ACCOUNT=%~1
if "%ACCOUNT%"=="" (
  ".venv\Scripts\python.exe" inject_shell.py --list
  echo.
  echo Usage: inject_shell.cmd ^<account^> [out_dir]
  echo Example: inject_shell.cmd GlynisWilliams9z0h
  echo Auto-pick session profile if empty account and profiles exist:
  ".venv\Scripts\python.exe" inject_shell.py --out "..\cli\downloads\inject"
  goto :eof
)

set OUT=%~2
if "%OUT%"=="" set OUT=..\cli\downloads\inject

echo [inject_shell] account=%ACCOUNT% out=%OUT%
".venv\Scripts\python.exe" inject_shell.py --account "%ACCOUNT%" --out "%OUT%" --url "https://www.dola.com/chat"
echo exit=%ERRORLEVEL%
endlocal
