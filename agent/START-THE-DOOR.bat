@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title MS BEAU AVE - door

REM Leave this window open. To have it start with the PC instead, run:
REM   npm install -g node-windows
REM   node service-install.js

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get the LTS installer from https://nodejs.org,
  echo   then run SELF-TEST.bat first.
  echo.
  pause
  exit /b 1
)

if not exist door.json (
  echo.
  echo   door.json is missing. Copy door.example.json to door.json and fill it
  echo   in - shop is 1 for Bayan Bayanan, 2 for Dao.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   Fetching what the agent needs, one moment...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   That failed. Run SELF-TEST.bat - it says why.
    echo.
    pause
    exit /b 1
  )
)

call node door.js
echo.
echo   The door has stopped. Anything above this line is the reason.
pause
