@echo off
setlocal
title Akatsuki - Update Giveaways

rem Project folder (edit this line if you move the repo).
set "REPO=c:\Users\jpdef\Game\Akatsuki Group"

cd /d "%REPO%"
if errorlevel 1 (
  echo Could not open project folder: %REPO%
  pause
  exit /b 1
)

echo ============================================
echo  Akatsuki - Update Giveaways
echo  Folder: %REPO%
echo ============================================
echo.

echo [1/3] Pulling latest changes from GitHub...
git pull
if errorlevel 1 goto :error

echo.
echo [2/3] Checking machine setup...
call setup-publish.cmd
if errorlevel 1 goto :error

echo.
echo [3/3] Publishing snapshot (sync giveaways + refresh + push)...
call publish-snapshot.cmd
if errorlevel 1 goto :error

echo.
echo Done. Giveaways updated and published.
pause
exit /b 0

:error
echo.
echo update-giveaways.bat failed. See the messages above.
pause
exit /b 1
