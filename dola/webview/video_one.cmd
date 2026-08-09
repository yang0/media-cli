@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv 2>nul || python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

set ACCOUNT=%~1
if "%ACCOUNT%"=="" set ACCOUNT=AureliaBronson1l5hd
set DURATION=%~2
if "%DURATION%"=="" set DURATION=15
set REF=%~3
if "%REF%"=="" set REF=E:\temp\avarta.png
set PROMPT=%~4
if "%PROMPT%"=="" set PROMPT=根据参考图中的可爱小女孩三视图，生成她微笑挥手并轻微转身的短视频，镜头平稳，角色外观与参考图一致

echo [video_one] account=%ACCOUNT% duration=%DURATION%s ref=%REF%
".venv\Scripts\python.exe" video_gen.py ^
  --account "%ACCOUNT%" ^
  --duration %DURATION% ^
  --aspect-ratio 9:16 ^
  --file "%REF%" ^
  --prompt "%PROMPT%" ^
  --out "..\cli\downloads\webview_video" ^
  --timeout 600 ^
  --close
echo exit=%ERRORLEVEL%
endlocal
