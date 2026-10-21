# Runs the witness on this laptop. Saving any file in witness/ restarts it (node --watch).
# Config comes from witness/.env, written by deploy/server/setup.sh. Log: ~/.coc-witness/witness.log
Set-Location $PSScriptRoot
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2]) }
}
$log = Join-Path $HOME '.coc-witness\witness.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
# The ledger lives outside witness/, so ledger writes don't trigger a restart.
# shortcut: after a crash node --watch waits for the next file save; the loop only covers a clean exit.
while ($true) {
  node --watch --watch-path=. server.js *>&1 | Out-File -FilePath $log -Append -Encoding utf8
  Start-Sleep -Seconds 3
}
