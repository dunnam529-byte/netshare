@echo off
title Regnis V2 Server
color 0A
cls
echo ===================================================
echo               REGNIS V2 SERVER START
echo ===================================================
echo.

:: Navigate to server directory safely
if exist "%~dp0server.js" (
    cd /d "%~dp0"
) else if exist "%~dp0server\server.js" (
    cd /d "%~dp0server"
)

:: Set Node flags for node:sqlite if supported
node --experimental-sqlite -e "process.exit(0)" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [OK] Node.js supports --experimental-sqlite.
    set NODE_OPTIONS=--experimental-sqlite
) else (
    echo [INFO] Node.js does not support --experimental-sqlite. Falling back to standard mode.
    set NODE_OPTIONS=
)

echo Current Directory: %CD%
echo Starting Regnis Server...
echo Press Ctrl+C at any time to stop the server.
echo ===================================================
echo.

call npm run dev

echo.
echo ===================================================
echo Server process ended. Press any key to exit.
echo ===================================================
pause
