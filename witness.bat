@echo off
REM ASUS laptop: one script to set up AND run the witness. Just run this every time.
REM The HMAC secret is fixed below so it always matches setup-lenovo-server.sh -- no copying,
REM no syncing between machines. This is a demo secret, not a production one.
setlocal enabledelayedexpansion

set "COC_HMAC_SECRET=7caf507e97c2c37e8e5e286fca914ba0ad1412deb1f2b0f36779d7ebe7d70c09"

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not installed. Install from https://nodejs.org/
    pause
    exit /b 1
)

echo Writing witness\.env...
(
    echo WITNESS_NODE_ID=ct105-ai
    echo WITNESS_HMAC_SECRET=%COC_HMAC_SECRET%
    echo WITNESS_BIND_HOST=0.0.0.0
    echo WITNESS_PORT=8787
    echo WITNESS_DATA_PATH=%USERPROFILE%\.coc-witness\ledger.jsonl
    echo BANK_RECONCILE_URL=http://192.168.31.77:3001/api/transactions/witness-reconcile
    echo WITNESS_ALLOW_LAN_HTTP=1
    echo WITNESS_LAYER1_ENABLED=1
) > witness\.env

if not exist "witness\node_modules" (
    echo Installing npm dependencies...
    pushd witness
    call npm install --omit=dev --silent
    popd
)

REM Load witness\.env into this process's environment (node server.js reads process.env directly).
for /f "usebackq tokens=1,* delims==" %%K in ("witness\.env") do (
    set "%%K=%%L"
)

echo.
echo === Starting witness ===
echo Dashboard: http://localhost:8787
echo Press Ctrl+C to stop.
echo.
cd witness
node server.js
