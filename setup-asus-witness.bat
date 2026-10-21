@echo off
REM One-stop setup for ASUS laptop (witness)
REM Run this once, then use run-witness.bat to start the witness

setlocal enabledelayedexpansion

echo.
echo === ASUS Laptop: Witness Setup ===
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not installed. Install from https://nodejs.org/
    pause
    exit /b 1
)

cd /d "%~dp0"

REM Generate random HMAC secret using PowerShell
for /f "delims=" %%A in ('powershell -NoProfile -Command "Write-Host -NoNewline ([Convert]::ToHexString([byte[]](Get-Random -SetSeed (Get-Random -Minimum 1 -Maximum 999999) -Count 32 | ForEach-Object {$_})))"') do set HMAC_SECRET=%%A

REM Fallback if PowerShell method fails
if "!HMAC_SECRET!"=="" (
    set HMAC_SECRET=abcdef1234567890abcdef1234567890
)

echo Creating witness\.env...
(
    echo WITNESS_NODE_ID=ct105-ai
    echo WITNESS_HMAC_SECRET=!HMAC_SECRET!
    echo WITNESS_BIND_HOST=0.0.0.0
    echo WITNESS_PORT=8787
    echo WITNESS_DATA_PATH=%USERPROFILE%\.coc-witness\ledger.jsonl
    echo BANK_RECONCILE_URL=http://192.168.31.77:3001/api/transactions/witness-reconcile
    echo WITNESS_ALLOW_LAN_HTTP=1
    echo WITNESS_LAYER1_ENABLED=1
) > witness\.env

if errorlevel 1 (
    echo ERROR: Failed to create witness\.env
    pause
    exit /b 1
)

echo Installing npm dependencies...
cd witness
call npm install --omit=dev --silent
cd ..

echo.
echo === Setup Complete ===
echo.
echo HMAC Secret (save this): !HMAC_SECRET!
echo.
echo Next: Run setup-lenovo-server.sh on the Lenovo with this secret.
echo Then: run-witness.bat to start the witness.
echo Dashboard: http://localhost:8787
echo.
pause
