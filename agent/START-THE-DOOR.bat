@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title MS BEAU AVE - door

REM Leave this window open. To have it start with the PC instead:
REM   npm install -g node-windows
REM   node service-install.js
REM (that one does need npm; running the door by hand does not)

if not exist sdk.js (
  echo.
  echo   The other files are not in this folder, so this was run from inside
  echo   the zip window. Right-click the download, choose "Extract All", and
  echo   run it from the extracted folder.
  echo.
  pause
  exit /b 1
)

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
  echo   This PC has not been set up yet.
  echo.
  echo   Right-click SETUP.bat, choose "Run as administrator", and answer:
  echo.
  echo       What is this computer?    2   the door at Bayan Bayanan
  echo                                 3   the door at Beauty Obsession Ave
  echo                                 1   the office PC that enrols fingers
  echo.
  echo   That writes door.json and starts everything by itself.
  echo.
  pause
  exit /b 1
)

call node door.js
echo.
echo   The door has stopped. Anything above this line is the reason.
pause
