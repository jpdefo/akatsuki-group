@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\publish-snapshot.ps1" %*
