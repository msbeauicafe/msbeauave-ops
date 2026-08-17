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

echo.
echo   Starting with a PRETEND scanner. Leave this window open, then open
echo   https://msbeauave-ops.vercel.app/clock/ in Chrome ON THIS PC.
echo.
echo   You should see "Place your finger" appear above the keypad, with a
echo   count of how many fingerprints this shop has on file. That count comes
echo   from the website, so seeing it proves the whole path except the scanner.
echo.

set SDK_STUB=1
call node door.js
echo.
echo   The door has stopped. Anything above this line is the reason.
pause
