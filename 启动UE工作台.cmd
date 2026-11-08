@echo off
cd /d "%~dp0"
call npm.cmd run build:ue
if errorlevel 1 exit /b %errorlevel%
call npm.cmd run dev:ue
