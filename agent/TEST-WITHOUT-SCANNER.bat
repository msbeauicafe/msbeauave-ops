@echo off
setlocal
cd /d "%~dp0"
title MS BEAU AVE - door (pretend scanner)

REM ---------------------------------------------------------------------------
REM The whole door, with a pretend scanner in place of the real one.
REM
REM This needs NOTHING installed but Node itself — no npm, no downloads, no
REM internet beyond reaching our own website. The one component the agent
REM normally fetches (koffi) is what talks to ZKTeco's library, and a pretend
REM scanner never touches it.
REM
REM So this is the thing to run when the rest of the setup is misbehaving: it
REM separates "the scanner is not working" from "everything else is not
REM working", and it will run on a machine where npm is broken or missing.
REM ---------------------------------------------------------------------------

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Get the LTS installer from https://nodejs.org,
  echo   then close this window, open a new one, and try again.
  echo.
  pause
  exit /b 1
)

if not exist door.json (
  echo   Making door.json from the example — the defaults are right for a test.
  copy /y door.example.json door.json >nul
)

REM door.js must be beside this file. If it is not, the batch file was run
REM from inside the zip window rather than from an extracted folder, which is
REM the commonest way this goes wrong and looks like nothing happening at all.
if not exist door.js (
  echo.
  echo   door.js is not in this folder, so this was almost certainly run from
  echo   inside the zip window. Windows copies the one file out to a temporary
  echo   folder and leaves the rest behind.
  echo.
  echo   Right-click the downloaded zip, choose "Extract All", put it somewhere
  echo   like C:\MBA door, and run this from THERE.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting with a PRETEND scanner. Leave this window open, then open
echo   http://127.0.0.1:9500/ in Chrome ON THIS PC - not the vercel address.
echo.
echo   You should see "Place your finger" appear above the keypad, with a
echo   count of how many fingerprints this shop has on file. That count comes
echo   from the website, so seeing it proves the whole path except the scanner.
echo.


set SDK_STUB=1
call node door.js
echo.
echo   The door has stopped. The reason is above, and in door-log.txt in this
echo   folder — send me that file if it is not obvious.
pause
