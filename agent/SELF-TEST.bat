@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title MS BEAU AVE - scanner self-test

echo.
echo   MS BEAU AVE - scanner self-test
echo   ==============================
echo.

REM ---------------------------------------------------------------------------
REM Everything below writes to install-log.txt as well as the screen. If any of
REM it fails, that file is the thing to send back - it says which step and why,
REM which is quicker than describing a window that has already closed.
REM ---------------------------------------------------------------------------
echo MS BEAU AVE self-test log > install-log.txt
echo %DATE% %TIME% >> install-log.txt

REM --- 1. Is Node.js here at all? --------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js is not installed on this PC.
  echo.
  echo   That is the whole problem - the ZKTeco driver being installed does not
  echo   help here, because this program is what talks to it, and it needs Node
  echo   to run at all.
  echo.
  echo   Get the LTS installer from https://nodejs.org - take every default,
  echo   and say yes if it offers to add Node to PATH. Then close this window,
  echo   open a NEW one, and double-click SELF-TEST.bat again.
  echo.
  echo   ^(A new window matters: an open one does not notice a new PATH.^)
  echo.
  echo FAIL: node not found >> install-log.txt
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v 2^>^&1') do set NODEV=%%v
for /f "delims=" %%v in ('node -p "process.arch" 2^>^&1') do set NODEARCH=%%v
echo   Node !NODEV!, !NODEARCH!
echo Node !NODEV! !NODEARCH! >> install-log.txt

REM Node 20 is the floor. Older ones lack things door.js uses outright.
for /f "tokens=1 delims=." %%a in ("!NODEV:v=!") do set NODEMAJOR=%%a
if !NODEMAJOR! LSS 20 (
  echo.
  echo   That is too old. Node 20 or newer is needed - get the LTS installer
  echo   from https://nodejs.org, then run this again.
  echo.
  echo FAIL: node too old >> install-log.txt
  pause
  exit /b 1
)

if /i not "!NODEARCH!"=="x64" (
  echo.
  echo   Note: this is 32-bit Node. That is fine ONLY if the ZKFinger SDK you
  echo   installed is also 32-bit. If the scanner step below fails saying the
  echo   DLL and Node do not match, this line is why.
  echo.
)

where npm >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node is installed but npm is not on PATH, which usually means the
  echo   installer was interrupted. Re-run the Node.js installer and take the
  echo   defaults.
  echo.
  echo FAIL: npm not found >> install-log.txt
  pause
  exit /b 1
)

REM --- 2. Settings ------------------------------------------------------------
if not exist door.json (
  echo.
  echo   door.json is missing.
  echo.
  echo   Copy door.example.json to door.json, open it in Notepad, and set:
  echo     shop  -  1 for Bayan Bayanan, 2 for Dao
  echo     password  -  the Timekeeper code
  echo.
  echo FAIL: no door.json >> install-log.txt
  pause
  exit /b 1
)
echo   door.json found

REM --- 3. What the agent needs to run ------------------------------------------
if not exist node_modules (
  echo.
  echo   Fetching what the agent needs. This takes a minute, and needs the
  echo   internet on this PC.
  echo.
  call npm install --no-audit --no-fund >> install-log.txt 2>&1
  if errorlevel 1 (
    echo.
    echo   That did not work. The reason is in install-log.txt, in this folder.
    echo   The usual causes, commonest first:
    echo.
    echo     - no internet on this PC, or a firewall blocking npm
    echo     - a company proxy: npm config set proxy http://your-proxy:port
    echo     - antivirus quarantining the download
    echo.
    echo   Send me install-log.txt and I will tell you which.
    echo.
    echo   The last few lines of it:
    echo   ------------------------------------------------------------
    powershell -NoProfile -Command "Get-Content install-log.txt -Tail 15" 2>nul
    echo   ------------------------------------------------------------
    echo.
    pause
    exit /b 1
  )
)
echo   the agent's parts are installed
echo.

REM --- 4. The scanner itself ---------------------------------------------------
call node selftest.js
echo.
echo   ------------------------------------------------------------
echo   A copy of this run is in install-log.txt.
echo   If any line above says FAIL, send me that file.
echo   ------------------------------------------------------------
echo.
pause
