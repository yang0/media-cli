@echo off
set PY=E:\projectHome\media-cli\dola\webview\.venv\Scripts\python.exe
if not exist "%PY%" set PY=python
"%PY%" E:\projectHome\media-cli\dola\cli\query_jobs.py
