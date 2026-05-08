@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\setup-publish.ps1" %*
