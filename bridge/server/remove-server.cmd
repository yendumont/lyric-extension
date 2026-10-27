@echo off
schtasks /Delete /TN "Lyrics Hub bridge" /F
netsh advfirewall firewall delete rule name="Lyrics Hub bridge"
echo Done. Close the helper window if it is still open. Delete .env to forget the token.
pause
