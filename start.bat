@echo off
title Financial Impact Analyzer
color 0A

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║  Financial Impact Analyzer                   ║
echo  ║  Portable AI-Powered Scenario Analysis       ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org/
    echo         Requires Node.js 18+ with npm
    pause
    exit /b 1
)

:: Show Node version
for /f "tokens=*" %%i in ('node -v') do echo  Node.js: %%i

:: First run? Install dependencies
if not exist "node_modules" (
    echo.
    echo  [SETUP] First run - installing dependencies...
    echo  This may take 1-2 minutes.
    echo.
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
)

if not exist "client\node_modules" (
    echo.
    echo  [SETUP] Installing client dependencies...
    echo.
    cd client
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] client npm install failed
        pause
        exit /b 1
    )
    cd ..
)

:: Build client if not built
if not exist "client\dist" (
    echo.
    echo  [BUILD] Building frontend...
    echo.
    cd client
    call npm run build
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] client build failed
        pause
        exit /b 1
    )
    cd ..
)

:: Start server
echo.
echo  [START] Launching server on http://localhost:3000
echo  Press Ctrl+C to stop
echo.

set NODE_ENV=production
call npx tsx server/index.ts

pause
