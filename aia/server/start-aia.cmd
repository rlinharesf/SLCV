@echo off
title Aia - servidor local
cd /d "%~dp0"
if not exist .env (
  echo [Aia] Arquivo .env nao encontrado. Copie .env.example para .env e preencha a ANTHROPIC_API_KEY.
  pause
  exit /b 1
)
if not exist node_modules (
  echo [Aia] Instalando dependencias...
  call npm install
)
if not exist dist\src\index.js (
  echo [Aia] Compilando...
  call npm run build
)
:loop
echo [Aia] Iniciando servidor...
node --enable-source-maps dist\src\index.js
echo [Aia] Servidor parou. Reiniciando em 5 segundos... (Ctrl+C para sair)
timeout /t 5 /nobreak >nul
goto loop
