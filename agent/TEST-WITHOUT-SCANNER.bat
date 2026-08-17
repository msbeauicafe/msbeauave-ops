@echo off
setlocal
cd /d "%~dp0"
title MS BEAU AVE - door (pretend scanner)

REM ---------------------------------------------------------------------------
REM The whole door, with a pretend scanner in place of the real one.
REM
REM For seeing that the rest of it works — that this PC can reach the website,
REM that it signs in, that it pulls down the right shop's fingerprints, and
REM that the clock page grows its "Place your finger" panel — without a ZK9500
REM plugged in. Nothing here touches ZKTeco's library, so it runs anywhere.
REM
REM It will never actually recognise a finger. That is the point: it separates
REM "the scanner is not working" from "everything else is not working".
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
  echo.
  echo   door.json is missing. Copy door.example.json to door.json first.
  echo   For a test on this PC the example values are fine as they are.
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
