@echo off
title Regnis V2 Server
color 0A
cls
echo ===================================================
echo               REGNIS V2 SERVER START
echo ===================================================
echo.

:: Navigate to server directory safely
if exist "%~dp0server\server.js" (
    cd /d "%~dp0server"
) else (
    cd /d "%~dp0"
)

echo Checking package installation...
node -e "try { require('express'); require('ws'); require('bcryptjs'); require('multer'); require('uuid'); } catch (e) { process.exit(1); }" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo [WARNING] Dependencies missing or incomplete.
    echo Running "npm install" automatically...
    echo.
    call npm install
) else (
    echo [OK] All packages are successfully installed.
)

:: Set Node flags for node:sqlite
set NODE_OPTIONS=--experimental-sqlite

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
