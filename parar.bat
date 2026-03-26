@echo off
title InstaMonitor — Parando servicos...
echo Encerrando InstaMonitor...
taskkill /F /FI "WINDOWTITLE eq InstaMonitor - Servidor*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq InstaMonitor - Frontend*" >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":3001 " ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do taskkill /F /PID %%p >nul 2>&1
echo Servicos encerrados.
timeout /t 2 /nobreak >nul
