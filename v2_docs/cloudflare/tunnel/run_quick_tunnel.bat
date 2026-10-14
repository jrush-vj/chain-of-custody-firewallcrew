@echo off
echo ========================================================
echo Starting Cloudflare Quick Tunnel for Chain of Custody
echo Exposing Witness on http://localhost:8000
echo ========================================================
echo.
cloudflared tunnel --url http://localhost:8000
pause
