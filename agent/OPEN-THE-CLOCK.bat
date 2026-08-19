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

REM Take the "downloaded from the internet" mark off the .bat files.
REM
REM Windows flags everything that came out of a zip and puts up "The publisher
REM could not be verified" every time one is run. On a door that is a dialog
REM standing between a power cut and the clock coming back, waiting for a click
REM nobody is there to give.
REM
REM SETUP.bat clears the whole folder, but updating means overwriting the files
REM and the mark comes back with them - and nobody re-runs setup to install an
REM update. So the starter clears its own kind on the way past: five files, not
REM the whole folder, so it costs nothing at boot. Quietly, and never fatal.
powershell -NoProfile -Command "Get-ChildItem -Path '%~dp0*.bat' | Unblock-File" >nul 2>&1

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
REM A desk enrols and a door clocks: different pages, different windows.
REM
REM A door is a kiosk. Full screen with nothing around it - no tabs, no address
REM bar, no back button. Somebody waiting to clock on has the clock in front of
REM them and nothing else on that PC to wander into.
REM
REM The office PC is somebody's desk, so it gets a window they can move and the
REM rest of the machine is left alone.
REM Its own Chrome, not the one somebody left open.
REM
REM This is what put the clock in an ordinary tab on this door. Chrome will
REM only run one copy per profile: ask a Chrome that is already up to open a
REM page and it hands the address to the running window as a new tab, and
REM every flag on the command line - --kiosk included - is dropped on the
REM floor. On a machine where nobody had opened Chrome first it worked, which
REM is exactly why it took a second door to find.
REM
REM Pointing it at a profile folder of its own makes it a separate copy, so
REM the kiosk is a kiosk whatever else is on that screen. A door wants its own
REM profile anyway: no bookmarks, no saved passwords, no history of whatever
REM the last person browsed, and the Timekeeper sign-in kept apart from a
REM person's own.
REM
REM Flat if lines rather than a block. A parenthesised block here expands its
REM variables before the branch is chosen, and %LOCALAPPDATA% on a machine
REM whose user folder has a bracket in it would end the block early - the same
REM shape of bug that broke finding Chrome in the first place.
set "PAGE=http://127.0.0.1:9500/"
set "ARGS=--kiosk http://127.0.0.1:9500/"
set "PROFILE=%LOCALAPPDATA%\MS BEAU AVE\door-chrome"
set "DESK="
findstr /i /c:"\"desk\": true" door.json >nul 2>&1
if not errorlevel 1 set "DESK=1"
if defined DESK set "PAGE=http://127.0.0.1:9500/office"
if defined DESK set "ARGS=--app=http://127.0.0.1:9500/office"
if defined DESK set "PROFILE=%LOCALAPPDATA%\MS BEAU AVE\desk-chrome"

REM The two disable flags are for the morning after a power cut. Chrome comes
REM back saying it did not shut down properly and offers to restore pages, and
REM that bar sits across the top of the door until somebody dismisses it -
REM which on a door screen means until somebody notices.
REM --no-first-run and --no-default-browser-check are for the profile above:
REM a Chrome opening a folder it has never seen starts on a welcome page and
REM an offer to be the default browser, which on a door is two dialogs
REM standing between a power cut and the clock coming back.
set "QUIET=--noerrdialogs --disable-session-crashed-bubble --disable-infobars --no-first-run --no-default-browser-check"

REM Ask Windows where Chrome is rather than guessing.
REM
REM "start chrome" goes through the App Paths registry entry, which every
REM installer writes and which is right whether Chrome went into Program Files,
REM the 32-bit one, or a single user's profile. Guessing at those three folders
REM is what put the clock in an ordinary tab on this PC for most of an
REM afternoon, and it would have done it again on any machine that keeps Chrome
REM somewhere else.
REM
REM start returns immediately either way, so the only way to know it worked is
REM to ask first whether Windows can resolve the name at all.
set "APPKEY=HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"
set "EXE="
reg query "%APPKEY%\chrome.exe" /ve >nul 2>&1 && set "EXE=chrome"
if not defined EXE reg query "%APPKEY%\msedge.exe" /ve >nul 2>&1 && set "EXE=msedge"

REM A per-user install writes the same entry under HKCU instead.
set "APPKEY=HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"
if not defined EXE reg query "%APPKEY%\chrome.exe" /ve >nul 2>&1 && set "EXE=chrome"
if not defined EXE reg query "%APPKEY%\msedge.exe" /ve >nul 2>&1 && set "EXE=msedge"

REM Falls back to whatever opens links if neither is registered, because a
REM clock in a tab still clocks people on. It says so out loud: silently doing
REM the lesser thing is how this went unnoticed for three goes.
REM Flat again, and for the same reason as above: %PROFILE% carries the Windows
REM user's folder name, and a bracket in somebody's name inside a parenthesised
REM block ends the block where the bracket is rather than where the block is.
if defined EXE echo   Opening the clock full screen...
if defined EXE start "" %EXE% %ARGS% %QUIET% --user-data-dir="%PROFILE%"
if defined EXE exit /b 0

echo.
echo   Neither Chrome nor Edge is registered with Windows, so the clock is
echo   opening in an ordinary browser window rather than full screen.
echo.
start "" "%PAGE%"
exit /b 0
