@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\setup-publish.ps1" %*
set "exit_code=%errorlevel%"
if not "%exit_code%"=="0" (
  echo.
  echo setup-publish.cmd failed with exit code %exit_code%.
  pause
)
exit /b %exit_code%
