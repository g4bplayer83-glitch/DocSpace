@echo off
setlocal
cd /d "%~dp0"

echo [DocSpace] Lancement du serveur Node (npm start)...
start "DocSpace Server" cmd /k "npm start"

echo [DocSpace] Lancement du dashboard Python...

where py >nul 2>nul
if %errorlevel%==0 (
    start "DocSpace Dashboard" cmd /k "py server_dashboard.py"
    goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
    start "DocSpace Dashboard" cmd /k "python server_dashboard.py"
    goto :end
)

echo [DocSpace] Python n'a pas ete trouve. Le serveur Node tourne quand meme.
echo [DocSpace] Installe Python pour lancer le dashboard local.

:end
endlocal