@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "PYTHON=.venv\Scripts\python.exe"
set "ACCOUNT=%~1"
set "OUT_DIR=%~dp0..\cli\downloads\inject"
set "LOG_DIR=%~dp0logs"

if /I "%ACCOUNT%"=="list" goto :list_accounts
if not defined ACCOUNT set "ACCOUNT=GlynisWilliams9z0h"

if not exist "%PYTHON%" (
    echo [setup] Creating Python virtual environment...
    py -3 -m venv .venv 2>nul
    if errorlevel 1 python -m venv .venv
    if errorlevel 1 goto :setup_failed

    echo [setup] Installing dependencies...
    "%PYTHON%" -m pip install -r requirements.txt
    if errorlevel 1 goto :setup_failed
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

echo.
echo ============================================================
echo  Dola WebView - manual video generation test
echo ============================================================
echo  Account  : %ACCOUNT%
echo  Downloads: %OUT_DIR%
echo  Logs     : %LOG_DIR%
echo.
echo  Steps:
echo    1. Click Video Generation
echo    2. Upload a reference image if needed
echo    3. Open Duration and select 15s
echo    4. Enter a prompt and submit
echo    5. Click the injected Download Video button
echo.
echo  The WebView remains open until you close it.
echo  Use the Dola menu to reinject scripts or open downloads.
echo ============================================================
echo.

"%PYTHON%" -u inject_shell.py ^
    --account "%ACCOUNT%" ^
    --out "%OUT_DIR%" ^
    --url "https://www.dola.com/chat" ^
    --log-dir "%LOG_DIR%"

set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo [done] WebView exited with code %EXIT_CODE%.
echo [done] Downloads: %OUT_DIR%
if exist "%LOG_DIR%\inject_shell_latest.log" (
    for /f "usebackq delims=" %%F in ("%LOG_DIR%\inject_shell_latest.log") do (
        echo [done] Latest log: %%F
    )
)
echo.
pause
exit /b %EXIT_CODE%

:list_accounts
if not exist "%PYTHON%" goto :setup_failed
"%PYTHON%" -u inject_shell.py --list --log-dir "%LOG_DIR%"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXIT_CODE%

:setup_failed
echo.
echo [error] Python environment setup failed.
echo [error] Run start.cmd once, then retry this script.
echo.
pause
exit /b 1
