@echo off
chcp 65001 >nul
title DocSpace — Tunnel Cloudflare

REM ============================================================
REM  CONFIGURATION — modifie ces valeurs
REM ============================================================
set LOCAL_PORT=3000
set RENDER_URL=https://docspace-redirect.onrender.com
set UPDATE_SECRET=IndieGabVR2024
REM ============================================================

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║     DocSpace — Lancement du tunnel       ║
echo  ╚══════════════════════════════════════════╝
echo.

REM Vérifie que cloudflared est installé
where cloudflared >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] cloudflared n'est pas installe !
    echo Telecharge-le ici : https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
    echo Ou via winget : winget install Cloudflare.cloudflared
    pause
    exit /b 1
)

echo [INFO] Lancement du tunnel sur localhost:%LOCAL_PORT%...
echo.

REM Lance cloudflared en arrière-plan et capture la sortie
set TUNNEL_LOG=%TEMP%\cloudflared_tunnel.log
if exist "%TUNNEL_LOG%" del "%TUNNEL_LOG%"

start /b "" cloudflared tunnel --url http://localhost:%LOCAL_PORT% 2>"%TUNNEL_LOG%"

REM Attend que l'URL du tunnel apparaisse dans les logs
set TUNNEL_URL=
set ATTEMPTS=0

:wait_loop
if %ATTEMPTS% geq 30 (
    echo [ERREUR] Timeout - impossible de récupérer l'URL du tunnel après 30s
    echo Vérifiez que le port %LOCAL_PORT% est accessible
    type "%TUNNEL_LOG%"
    pause
    exit /b 1
)

timeout /t 1 /nobreak >nul
set /a ATTEMPTS+=1

REM Cherche l'URL https://...trycloudflare.com dans le log
for /f "tokens=*" %%A in ('findstr /r "https://.*trycloudflare.com" "%TUNNEL_LOG%" 2^>nul') do (
    for %%B in (%%A) do (
        echo %%B | findstr /r "^https://.*trycloudflare.com" >nul 2>&1
        if not errorlevel 1 (
            set TUNNEL_URL=%%B
        )
    )
)

if "%TUNNEL_URL%"=="" goto wait_loop

echo [OK] Tunnel actif : %TUNNEL_URL%
echo.

REM Envoie l'URL au serveur Render
echo [INFO] Envoi de l'URL au proxy Render...
curl -s -X POST "%RENDER_URL%/update-link" ^
    -H "Content-Type: application/json" ^
    -H "X-Secret: %UPDATE_SECRET%" ^
    -d "{\"url\":\"%TUNNEL_URL%\"}" >nul 2>&1

if errorlevel 1 (
    echo [ATTENTION] Impossible d'envoyer l'URL au proxy Render
    echo Vérifiez que %RENDER_URL% est accessible
) else (
    echo [OK] URL envoyée au proxy Render !
)

echo.
echo ══════════════════════════════════════════════════
echo   Tunnel URL  : %TUNNEL_URL%
echo   Render proxy: %RENDER_URL%
echo   Port local  : %LOCAL_PORT%
echo ══════════════════════════════════════════════════
echo.
echo   Appuyez sur une touche pour ARRÊTER le tunnel
echo   (le serveur Render sera marqué hors ligne)
echo.
pause >nul

REM Marque le serveur comme hors ligne sur Render
echo.
echo [INFO] Arrêt du tunnel et mise hors ligne...
curl -s -X POST "%RENDER_URL%/set-offline" ^
    -H "Content-Type: application/json" ^
    -H "X-Secret: %UPDATE_SECRET%" ^
    -d "{\"secret\":\"%UPDATE_SECRET%\"}" >nul 2>&1

REM Termine cloudflared
taskkill /f /im cloudflared.exe >nul 2>&1

echo [OK] Tunnel fermé et serveur marqué hors ligne.
timeout /t 3 >nul
