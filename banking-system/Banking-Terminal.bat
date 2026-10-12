@echo off
setlocal

rem Move to the folder where this .bat lives (the repo root).
pushd "%~dp0"

rem Launch PowerShell in the same window, bypass policy for this process,
rem run the CLI, and keep the window open afterwards.
powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass ^
  -Command "& { Set-Location '%~dp0'; node backend/cli.js }"

popd
