@echo off
cd /d "%~dp0"
where node >nul 2>&1 || (echo.& echo   Node.js is not installed. Get it from https://nodejs.org& echo.& pause& exit /b 1)
call node configure.js door 1
pause
