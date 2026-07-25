@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv 2>nul || python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)
if not exist "logs" mkdir logs

set ACCOUNT=%~1
if "%ACCOUNT%"=="" (
  ".venv\Scripts\python.exe" -u inject_shell.py --list --log-dir "%~dp0logs"
  echo.
  echo Usage:
  echo   inject_shell.cmd ^<account^> [out_dir]
  echo   inject_shell.cmd auto ^<account^> [duration] [ref.png]
  echo Example:
  echo   inject_shell.cmd GlynisWilliams9z0h
  echo   inject_shell.cmd auto GlynisWilliams9z0h 15 E:\temp\avarta.png
  echo Logs: %~dp0logs\
  goto :eof
)

if /I "%ACCOUNT%"=="auto" (
  set ACC=%~2
  if "%ACC%"=="" set ACC=GlynisWilliams9z0h
  set DUR=%~3
  if "%DUR%"=="" set DUR=15
  set REF=%~4
  set OUT=..\cli\downloads\inject
  echo [inject_shell] AUTO account=%ACC% duration=%DUR%s ref=%REF%
  echo [inject_shell] logs=%~dp0logs\
  if "%REF%"=="" (
    ".venv\Scripts\python.exe" -u inject_shell.py --account "%ACC%" --auto --duration %DUR% --aspect-ratio 9:16 --prompt "一只可爱的小猫在窗台阳光下走动，镜头平稳" --out "%OUT%" --timeout 600 --close --log-dir "%~dp0logs"
  ) else (
    ".venv\Scripts\python.exe" -u inject_shell.py --account "%ACC%" --auto --duration %DUR% --aspect-ratio 9:16 --file "%REF%" --prompt "根据参考图中的可爱小女孩三视图，生成她微笑挥手并轻微转身的短视频，镜头平稳，角色外观与参考图一致" --out "%OUT%" --timeout 600 --close --log-dir "%~dp0logs"
  )
  echo exit=%ERRORLEVEL%
  if exist "%~dp0logs\inject_shell_latest.log" (
    for /f "usebackq delims=" %%F in ("%~dp0logs\inject_shell_latest.log") do echo latest log: %%F
  )
  goto :eof
)

set OUT=%~2
if "%OUT%"=="" set OUT=..\cli\downloads\inject

echo [inject_shell] account=%ACCOUNT% out=%OUT%
echo [inject_shell] logs=%~dp0logs\
".venv\Scripts\python.exe" -u inject_shell.py --account "%ACCOUNT%" --out "%OUT%" --url "https://www.dola.com/chat" --log-dir "%~dp0logs"
echo exit=%ERRORLEVEL%
if exist "%~dp0logs\inject_shell_latest.log" (
  for /f "usebackq delims=" %%F in ("%~dp0logs\inject_shell_latest.log") do echo latest log: %%F
)
endlocal
