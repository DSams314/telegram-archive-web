@echo off
REM Double-click to install Telegram Archive for the current user.
cd /d "%~dp0"
cls

where python >nul 2>&1
if errorlevel 1 goto nopython
python -c "import sys; sys.exit(0 if sys.version_info>=(3,9) else 1)" >nul 2>&1
if errorlevel 1 goto oldpython

python tools\install.py
echo.
pause
exit /b

:nopython
echo Telegram Archive needs Python 3.
echo.
echo   1. Install Python 3 from https://www.python.org/downloads/
echo      IMPORTANT: tick "Add python.exe to PATH" during setup
echo   2. Run this installer again
echo.
pause
exit /b 1

:oldpython
echo Your Python is too old. Version 3.9 or newer is required.
echo Download a current version from https://www.python.org/downloads/
echo.
pause
exit /b 1
