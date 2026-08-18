@echo off
REM Everything, in one conversation.
REM Right-click this file and choose "Run as administrator" if you want the
REM door to start with Windows.
setlocal
cd /d "%~dp0"
title MS BEAU AVE - setup

REM Anything printed here also lands in setup-log.txt, because a window that
REM closes takes the reason with it and a file can be sent to somebody.
echo MS BEAU AVE setup, %DATE% %TIME% > setup-log.txt

REM Take Windows' "downloaded from the internet" mark off this folder.
REM
REM Everything here arrived inside a zip, so Windows flags every .bat in it and
REM puts up "The publisher could not be verified" each time one is run. On a
REM door PC that means the clock stops at a dialog on every restart, waiting
REM for somebody to click Run - and the whole point is that nobody has to.
REM
REM Quietly, and never fatal: if PowerShell is locked down the mark stays and
REM the only cost is the dialog we were trying to spare people.
powershell -NoProfile -Command "Get-ChildItem -Path '%~dp0' -Recurse -File | Unblock-File" >nul 2>&1
if errorlevel 1 (echo note: could not clear the downloaded-file mark >> setup-log.txt) else (echo cleared the downloaded-file mark >> setup-log.txt)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this PC.
  echo.
  echo   Get the LTS installer from https://nodejs.org - take every default -
  echo   then CLOSE this window, open a NEW one, and run SETUP.bat again.
  echo   ^(A window that is already open does not notice a new program.^)
  echo.
  echo FAIL: node not found >> setup-log.txt
  pause
  exit /b 1
)

if not exist setup.js (
  echo.
  echo   setup.js is not in this folder, so this was run from inside the zip
  echo   window. Right-click the download, choose "Extract All", and run
  echo   SETUP.bat from the extracted folder.
  echo.
  echo FAIL: setup.js missing >> setup-log.txt
  pause
  exit /b 1
)

call node setup.js
if errorlevel 1 (
  echo.
  echo   Setup stopped. The reason is above, and in setup-log.txt.
)
echo.
echo   ----------------------------------------------------------
echo   This window stays open so nothing disappears before you can
echo   read it. Close it when you are done.
echo   ----------------------------------------------------------
pause
