@echo off
setlocal
cd /d "%~dp0"
set IDX=%~1
if "%IDX%"=="" set IDX=0

if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv 2>nul || python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

echo [dola-webview] login first, export only after success. accounts index=%IDX%
".venv\Scripts\python.exe" dola_webview.py ^
  --accounts "..\google_mail.txt" ^
  --index %IDX% ^
  --auto-login ^
  --auto-export ^
  --out "G:\cookies\dola" ^
  --login-timeout 300

endlocal
