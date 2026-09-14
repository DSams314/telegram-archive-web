@echo off
REM Double-click to remove Telegram Archive. Your chat exports are kept.
cd /d "%~dp0"
cls
where python >nul 2>&1
if errorlevel 1 (
  echo Python 3 was not found, so this cannot run automatically.
  echo You can simply delete this folder by hand -- but move the
  echo "Backups" folder somewhere safe first, or you will lose your exports.
  echo.
  pause
  exit /b 1
)
python tools\uninstall.py --from "%CD%"
echo.
pause
