@echo off
REM Run this first. It proves the scanner works before anything else is blamed.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing what the agent needs, one moment...
  call npm install || goto fail
)
if not exist door.json (
  echo.
  echo door.json is missing. Copy door.example.json to door.json and fill it in first.
  echo.
  pause
  exit /b 1
)
call npm run selftest
echo.
pause
exit /b 0
:fail
echo.
echo npm install failed. Is Node.js installed? Get it from nodejs.org.
pause
