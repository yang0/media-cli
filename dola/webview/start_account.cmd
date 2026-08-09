@echo off
setlocal
cd /d "%~dp0"
set ACC=%~1
if "%ACC%"=="" set ACC=dola_acc1

if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv 2>nul || python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

echo [dola-webview] open account %ACC%
".venv\Scripts\python.exe" dola_webview.py --account "%ACC%" --out "G:\cookies\dola"
endlocal
