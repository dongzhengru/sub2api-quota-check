@echo off
chcp 65001 >nul
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0codex-sidebar\windows\sidebar.ps1" -Action start -Interactive
if errorlevel 1 pause
