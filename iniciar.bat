@echo off
title InstaMonitor — Iniciando...
cd /d "%~dp0"

echo.
echo  =========================================
echo   InstaMonitor — Iniciando servicos...
echo  =========================================
echo.

:: Matar processos antigos na porta 3001 e 5173
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":3001 " ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do (
  taskkill /F /PID %%p >nul 2>&1
)

echo [1/3] Iniciando servidor backend (porta 3001)...
start "InstaMonitor - Servidor" /min cmd /c "cd /d "%~dp0server" && node index.js"

:: Aguarda o servidor subir
timeout /t 3 /nobreak >nul

echo [2/3] Iniciando servidor de desenvolvimento (porta 5173)...
start "InstaMonitor - Frontend" /min cmd /c "cd /d "%~dp0" && npm run dev"

:: Aguarda o Vite subir
timeout /t 4 /nobreak >nul

echo [3/3] Abrindo no navegador...
start "" "http://localhost:5173"

echo.
echo  =========================================
echo   Tudo pronto! Pode fechar esta janela.
echo   Para parar: feche as janelas minimizadas
echo   ou execute parar.bat
echo  =========================================
echo.
pause
