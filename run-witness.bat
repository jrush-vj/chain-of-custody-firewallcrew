@echo off
REM Start the witness on this laptop
setlocal enabledelayedexpansion

cd /d "%~dp0"
if exist "witness\.env" (
    echo Starting witness...
    cd witness
    node server.js
) else (
    echo ERROR: witness\.env not found. Run setup-asus-witness.bat first.
    pause
    exit /b 1
)
