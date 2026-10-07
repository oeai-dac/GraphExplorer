@echo off
setlocal enabledelayedexpansion
title GraphExplorer

REM Always work in the folder of this file (wherever it is double-clicked from)
cd /d "%~dp0"

echo.
echo   ============================================
echo   ==             GraphExplorer              ==
echo   ============================================
echo.

REM ---------------------------------------------------------------------------
REM  1) Is Node.js installed?
REM ---------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo   [!] Node.js was not found on this computer.
    echo.
    echo       Please install Node.js once ^(the "LTS" version^):
    echo         https://nodejs.org/en/download
    echo.
    echo       After the installation, simply double-click
    echo       this file again.
    echo.
    pause
    exit /b 1
)

REM ---------------------------------------------------------------------------
REM  2) First start only: install the required components
REM ---------------------------------------------------------------------------
if not exist "node_modules" (
    echo   [i] First start - installing the required components.
    echo       This takes a few minutes, once. Please wait...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo   [x] The installation failed.
        echo       Please check your internet connection and start this file again.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo   [ok] Installation complete.
    echo.
)

REM ---------------------------------------------------------------------------
REM  3) Start the GraphExplorer - the browser opens automatically
REM ---------------------------------------------------------------------------
echo   [i] The GraphExplorer is starting and will open in your browser.
echo       Address (usually):  http://localhost:3001
echo.
echo   ------------------------------------------------------------
echo    Please keep this window OPEN while you use the app.
echo    To quit, simply close this window.
echo   ------------------------------------------------------------
echo.

call npm run dev -- --open

REM If the server ends unexpectedly, keep the window open:
echo.
echo   [i] The GraphExplorer has stopped.
pause
