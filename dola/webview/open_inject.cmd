@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo create venv...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

if not exist "logs" mkdir logs

set ACCOUNT=%~1
if "%ACCOUNT%"=="" set ACCOUNT=GlynisWilliams9z0h
set OUT=%~2
if "%OUT%"=="" set OUT=%~dp0..\cli\downloads\inject

echo.
echo ============================================
echo  Dola 注入壳（手动模式，窗口会一直开着）
echo  账号: %ACCOUNT%
echo  下载: %OUT%
echo  详细日志: %~dp0logs\
echo  （运行后查看 inject_shell_*.log / inject_shell_latest.log）
echo ============================================
echo  操作: 视频生成 -^> 传图 -^> 时长15s -^> 发送 -^> 点下载视频
echo  若无下载按钮: 菜单 Dola注入 -^> 重新注入脚本
echo  菜单也可「打开日志文件」
echo  关掉窗口后此黑窗才会结束
echo ============================================
echo.

".venv\Scripts\python.exe" -u inject_shell.py --account "%ACCOUNT%" --out "%OUT%" --url "https://www.dola.com/chat" --log-dir "%~dp0logs"
set ERR=%ERRORLEVEL%
echo.
echo shell exit=%ERR%
echo 详细日志目录: %~dp0logs\
if exist "%~dp0logs\inject_shell_latest.log" (
  for /f "usebackq delims=" %%F in ("%~dp0logs\inject_shell_latest.log") do (
    echo 最新日志文件: %%F
  )
)
echo 若秒退，请把 logs 目录下最新 inject_shell_*.log 发给我
pause
endlocal
