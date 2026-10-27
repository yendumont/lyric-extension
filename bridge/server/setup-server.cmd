@echo off
rem Sets the helper up to run for your phones: makes the token, starts it at every logon, opens the firewall port.
cd /d "%~dp0.."
where node >nul 2>nul || (echo Node.js 22 or newer is needed first: https://nodejs.org & pause & exit /b 1)
node lyrics-bridge.mjs --init
if errorlevel 1 (pause & exit /b 1)
echo.
schtasks /Create /TN "Lyrics Hub bridge" /TR "\"%~dp0run-server.cmd\"" /SC ONLOGON /F >nul && echo Will start by itself every time you log in. || echo Could not add the start-at-logon task.
netsh advfirewall firewall add rule name="Lyrics Hub bridge" dir=in action=allow protocol=TCP localport=8089 profile=private >nul 2>nul && echo Firewall: port 8089 opened for private networks. || echo Firewall rule not added (run this as Administrator, or press Allow when Windows asks about node.exe).
echo.
echo Starting it now. Copy the address and token above into Mornye.
start "" "%~dp0run-server.cmd"
pause
