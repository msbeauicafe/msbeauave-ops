@echo off
REM One click: start the door if it is not already running, then open it.
REM
REM Two steps was one too many. Nobody should have to know whether a program
REM is running before they can open a screen.
setlocal
cd /d "%~dp0"
title MS BEAU AVE

if not exist door.js (
  echo.
  echo   The other files are not in this folder, so this was run from inside
  echo   the zip window. Right-click the download, choose "Extract All", and
  echo   run it from the extracted folder.
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

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get the LTS installer from https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM Is it already up? Then just open it. Starting a second one would only
REM fight the first for the port, and lose.
netstat -an | find ":9500" | find "LISTENING" >nul
if not errorlevel 1 goto open

echo   Starting the door...
start "MS BEAU AVE door" cmd /c "node door.js & pause"

REM Give it a moment to take the port before pointing a browser at it.
set /a tries=0
:wait
set /a tries+=1
ping -n 2 127.0.0.1 >nul
netstat -an | find ":9500" | find "LISTENING" >nul
if not errorlevel 1 goto open
if %tries% LSS 15 goto wait
echo.
echo   The door did not start. Look at the other window, or door-log.txt.
echo.
pause
exit /b 1

:open
REM A desk enrols and a door clocks; each wants a different page.
set "PAGE=http://127.0.0.1:9500/"
findstr /i /c:"\"desk\": true" door.json >nul 2>&1
if not errorlevel 1 set "PAGE=http://127.0.0.1:9500/office"

REM Open it as a window of its own rather than a tab.
REM
REM A door screen with an address bar is an invitation: somebody waiting to
REM clock on has a whole browser in front of them, and the clock is the one
REM thing on that PC they are meant to touch. --app gives a plain window with
REM no tabs, no address bar and no back button, on the same page either way.
REM
REM Falls back to whatever opens links if neither browser is where it usually
REM lives, because a clock in a tab still clocks people on.
set "BROWSER="
for %%B in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%B set "BROWSER=%%~B"

if defined BROWSER (
  start "" "%BROWSER%" --app=%PAGE% --start-fullscreen
) else (
  start "" "%PAGE%"
)
exit /b 0
