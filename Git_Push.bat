@echo off
setlocal enableDelayedExpansion

REM **********************************************************
REM Git_Push.bat - Robust Script for Initial Setup and Push
REM FIX: Corrected batch 'errorlevel' logic to properly detect and handle the rejected push.
REM **********************************************************

REM --- 1. Use the BAT file's save location (MANDATORY) ---
cd /d "%~dp0"
set "PROJECT_DIR=%cd%"

echo.
echo ==========================================================
echo Starting Git Setup in: %PROJECT_DIR%
echo ==========================================================
echo.

REM --- 2. Initialize the Repository ---
if not exist .git (
echo Initializing new Git repository...
git init
if errorlevel 1 goto ERROR_GIT
) else (
echo Git repository already initialized. Skipping 'git init'.
)

echo.
echo --- 3. Stage Files ---
echo Adding all project files to staging area...
git add .
if errorlevel 1 goto ERROR_GIT
echo.

REM --- 4. Commit Files ---
REM Check if there are any changes to commit before trying to commit.
git status --porcelain | findstr /R "." > nul
if errorlevel 1 (
echo No new changes detected. Skipping 'git commit'.
) else (
echo Creating the commit...
git commit -m "Automated commit from Git_Push.bat"
if errorlevel 1 goto ERROR_GIT
)

echo.
echo --- 5. Branch Renaming ---
echo Setting branch name to 'main'...
git branch -M main
if errorlevel 1 goto ERROR_GIT

echo.
echo --- 6. Add Remote Origin (Force clean setup) ---
:ASK_URL
set "REMOTE_URL="
set /p REMOTE_URL="Please enter the GitHub remote URL (e.g., https://github.com/user/repo.git): "
if "%REMOTE_URL%"=="" (
echo Error: Remote URL cannot be empty.
goto ASK_URL
)

echo Checking for existing remote 'origin' and removing it if found...
REM Suppress error if 'origin' does not exist (2>nul)
git remote remove origin 2>nul

echo Adding remote origin: %REMOTE_URL%
git remote add origin "%REMOTE_URL%"
if errorlevel 1 goto ERROR_GIT

REM --- 7. Push to GitHub (With robust conflict resolution) ---
echo.
echo --- 7. Push to GitHub (With conflict resolution for existing repos) ---
echo Pushing the 'main' branch to the remote repository...
git push -u origin main

REM ** FIX: Check for failure (errorlevel 1) directly **
if errorlevel 1 goto REJECTED_PUSH

REM --- If push succeeded on first try ---
goto SUCCESS

:REJECTED_PUSH
REM --- Handle Rejected Push (errorlevel 1 indicates a non-fast-forward issue) ---
echo.
echo **********************************************************
echo PUSH REJECTED! (Remote repository has newer or conflicting commits).
echo Running: git pull origin main --allow-unrelated-histories -X ours...
echo This will safely merge remote history while keeping your local files.
echo **********************************************************

REM Pull remote changes, allow unrelated histories, and keep local changes for conflicts
git pull origin main --allow-unrelated-histories -X ours --no-edit

if errorlevel 1 (
echo.
echo PULL FAILED! Manual intervention is required to resolve merge conflicts.
goto FINAL_ERROR
)

echo Re-attempting push after successful rebase...
git push -u origin main

if errorlevel 1 (
echo.
echo FINAL PUSH FAILED! Authentication or Permissions issue.
goto FINAL_ERROR
)

:SUCCESS
echo.
echo ==========================================================
echo Git Initial Setup and Push Completed Successfully!
echo ==========================================================
goto END

:ERROR_GIT
echo.
echo ==========================================================
echo A GIT COMMAND FAILED. Please check the error message above.
echo ==========================================================
goto END

:FINAL_ERROR
echo.
echo **********************************************************
echo TROUBLESHOOTING:
echo 1. Check your GitHub Credentials (A popup may be waiting).
echo 2. Verify you have Write Permissions to the repository.
echo 3. If "PULL FAILED" showed, you must manually run:
echo    "git status" to see unmerged files, resolve conflicts, and commit.
echo **********************************************************

:END
endlocal
pause