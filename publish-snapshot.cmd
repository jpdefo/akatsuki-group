@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\publish-snapshot.ps1" %*
set "exit_code=%errorlevel%"
if not "%exit_code%"=="0" (
  echo.
  echo publish-snapshot.cmd failed with exit code %exit_code%.
  pause
)
exit /b %exit_code%
