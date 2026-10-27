@echo off
title Lyrics Hub bridge (server)
cd /d "%~dp0.."
:again
node lyrics-bridge.mjs
echo.
echo The helper stopped. Restarting in 10 seconds (close this window to stop it).
timeout /t 10 /nobreak >nul
goto again
