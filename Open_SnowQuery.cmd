@echo off
setlocal
cd /d "%~dp0"

echo Starting SnowQuery...

if not exist node_modules (
  echo Installing Node packages...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

start "" http://localhost:3000
npm start
