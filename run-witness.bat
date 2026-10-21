@echo off
cd /d "%~dp0"
if not exist "witness\.env" (
    echo ERROR: witness\.env not found. Run setup-asus-witness.bat first.
    pause
    exit /b 1
)
cd witness
node server.js
