@echo off
rem Waarp build in Waarp colours: steps, progress bar, live timer (scripts\build.ps1). Args: 1, 2 or 3 / apk (no arg = asks).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build.ps1" %1
set "WAARP_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %WAARP_EXIT%
