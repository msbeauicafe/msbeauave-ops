@echo off
REM Everything, in one conversation. Right-click and "Run as administrator"
REM if you want it to start with the PC.
cd /d "%~dp0"
title MS BEAU AVE - setup
where node >/dev/null 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed yet. Get the LTS installer from
  echo   https://nodejs.org - take every default - then close this window,
  echo   open a new one, and run SETUP.bat again.
  echo.
  pause
  exit /b 1
)
call node setup.js
