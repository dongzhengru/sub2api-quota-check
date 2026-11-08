@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0codex-sidebar\windows\sidebar.ps1" -Action start
if errorlevel 1 pause
