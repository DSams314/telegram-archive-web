@echo off
REM Windows: double-click this file. Requires Python 3 with "Add to PATH".
REM Stop it with the power button in the app.
cd /d "%~dp0"

REM A failed index must not stop the server: a fresh copy has no backup folder
REM yet, and the server is what serves the setup that asks for one.
python -m tools.tgindex
python serve.py
pause
