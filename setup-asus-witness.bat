@echo off
REM Setup script for ASUS laptop (witness + defense demo UI)
REM This installs Node.js dependencies and starts the witness dashboard

setlocal enabledelayedexpansion

echo.
echo === ASUS Laptop: Witness + Defense Demo UI ===
echo.

REM Check if Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed. Please install Node.js 18+ from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if Git is installed
where git >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git is not installed. Please install Git Bash.
    pause
    exit /b 1
)

echo Detected Node.js:
node --version

cd /d "%~dp0"
if errorlevel 1 (
    echo ERROR: Failed to change to repo directory
    pause
    exit /b 1
)

echo Current directory: !cd!

REM Check if witness .env exists
if not exist "witness\.env" (
    echo.
    echo Creating witness\.env...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$secret = [System.Convert]::ToHexString([byte[]](0..31 ^| ForEach-Object {Get-Random -Minimum 0 -Maximum 256})); " ^
        "@('WITNESS_NODE_ID=ct105-ai', " ^
        "'WITNESS_HMAC_SECRET=' + $secret, " ^
        "'WITNESS_BIND_HOST=0.0.0.0', " ^
        "'WITNESS_PORT=8787', " ^
        "'WITNESS_DATA_PATH=' + [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Personal'), '.coc-witness', 'ledger.jsonl'), " ^
        "'BANK_RECONCILE_URL=http://192.168.31.77:3001/api/transactions/witness-reconcile', " ^
        "'WITNESS_ALLOW_LAN_HTTP=1', " ^
        "'WITNESS_LAYER1_ENABLED=1') ^| Out-File -FilePath witness\.env -Encoding UTF8"

    if errorlevel 1 (
        echo ERROR: Failed to create witness\.env
        pause
        exit /b 1
    )
    echo Created witness\.env
)

REM Install npm dependencies for witness
echo.
echo Installing witness dependencies...
cd witness
call npm install --omit=dev
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)
cd ..

echo.
echo === Setup Complete ===
echo.
echo Next steps:
echo 1. Keep this laptop on the LAN (192.168.31.29)
echo 2. Run: powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-ScheduledTask -TaskName 'CoC witness'"
echo 3. Open witness dashboard: http://localhost:8787
echo 4. Bank site: http://192.168.31.77:3001
echo.
echo To start the witness manually, run: run-witness.bat
echo.
pause
