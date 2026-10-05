@echo off
rem Waarp build in Waarp colours: steps, progress bar, live timer (scripts\build.ps1). Args: 1 or 2 (no arg = asks).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build.ps1" %1
echo.
pause
