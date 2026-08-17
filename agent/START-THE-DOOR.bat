@echo off
REM Starts the door. Leave this window open, or install it as a service
REM with:  npm install -g node-windows  then  node service-install.js
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
call npm start
pause
exit /b 0
:fail
echo.
echo npm install failed. Is Node.js installed? Get it from nodejs.org.
pause
