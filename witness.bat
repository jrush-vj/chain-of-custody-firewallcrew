@echo off
REM ASUS laptop: one script to set up AND run the witness.
REM First run: generates a secret, creates witness\.env, installs deps, starts the witness.
REM Every run after: reuses the existing .env and just starts the witness.
setlocal enabledelayedexpansion

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not installed. Install from https://nodejs.org/
    pause
    exit /b 1
)

if exist "witness\.env" goto :run

echo.
echo === First run: setting up witness\.env ===
echo.

REM Generate the secret via a temp .ps1 file written one line at a time (each its own
REM standalone redirect, not a parens-grouped block) so literal ( ) in the PowerShell
REM text below can never be misread as cmd.exe block syntax.
set "PS1=%TEMP%\coc-gen-secret-%RANDOM%.ps1"
set "OUT=%TEMP%\coc-secret-%RANDOM%.txt"
> "%PS1%" echo $bytes = New-Object byte[] 32
>>"%PS1%" echo $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
>>"%PS1%" echo $rng.GetBytes($bytes)
>>"%PS1%" echo -join ($bytes ^| ForEach-Object { $_.ToString('x2') })

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" > "%OUT%"
set /p HMAC_SECRET=<"%OUT%"
del "%PS1%" "%OUT%" >nul 2>&1

if "%HMAC_SECRET%"=="" (
    echo ERROR: Failed to generate a secret. Is PowerShell available?
    pause
    exit /b 1
)

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

echo Created witness\.env
echo.
echo Installing npm dependencies...
pushd witness
call npm install --omit=dev --silent
popd

echo.
echo =====================================================================
echo  HMAC SECRET (copy this into the Lenovo server's .env and
echo  /etc/coc-layer1/monitor.env, replacing WITNESS_HMAC_SECRET):
echo.
echo    !HMAC_SECRET!
echo.
echo =====================================================================
echo.
pause

:run
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
