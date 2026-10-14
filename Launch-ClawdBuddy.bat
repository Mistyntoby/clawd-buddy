@echo off
rem Clawd Buddy development launcher for Windows.
rem Double-click to start Clawd Buddy from this folder (runs "npm start").
rem It never installs anything globally, needs no administrator rights, and
rem only installs project dependencies after you confirm.
setlocal EnableExtensions
title Clawd Buddy
cd /d "%~dp0" || goto :fail_dir

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 22 or newer ^(the LTS version is fine^) from https://nodejs.org/ and run this launcher again.
  goto :pause_exit
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 22 (
  echo Clawd Buddy needs Node.js 22 or newer; this computer has:
  node --version
  echo Install a newer version from https://nodejs.org/ and try again.
  goto :pause_exit
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. It normally comes with Node.js; reinstall Node.js from https://nodejs.org/.
  goto :pause_exit
)

if not exist "node_modules\electron\package.json" (
  echo Project dependencies are not installed yet.
  echo This downloads the packages listed in package-lock.json from the npm registry into this folder.
  choice /C YN /M "Install them now with 'npm ci'"
  if errorlevel 2 (
    echo Okay. You can install them later by running:  npm ci
    goto :pause_exit
  )
  call npm ci
  if errorlevel 1 goto :fail_install
)

rem Electron downloads its runtime in an install step; repair it if that step was skipped.
if not exist "node_modules\electron\dist\electron.exe" (
  echo Downloading the Electron runtime...
  node node_modules\electron\install.js
  if errorlevel 1 goto :fail_install
)

echo Starting Clawd Buddy... (close this window or press Ctrl+C to stop it)
call npm start
if errorlevel 1 (
  echo.
  echo Clawd Buddy stopped with an error. The messages above explain what went wrong.
  goto :pause_exit
)
exit /b 0

:fail_dir
echo Could not open the project folder.
goto :pause_exit

:fail_install
echo.
echo Installing dependencies failed. Check your internet connection and the messages above,
echo then run "npm ci" in this folder.

:pause_exit
echo.
pause
exit /b 1
