@echo off
title Update HapsHub
rem Double-click this from Explorer. It waits for HapsHub to close, rebuilds it, and opens it again.
rem Your data isn't touched. If the build fails, the old copy stays as it was.
set "ROOT=%~dp0..\.."
set "EXE=%ROOT%\bin\Release\net10.0-windows10.0.19041.0\HapsHub.exe"

tasklist /FI "IMAGENAME eq HapsHub.exe" /NH | find /I "HapsHub.exe" >nul
if not errorlevel 1 echo Please exit HapsHub from the tray icon. Waiting for it to close...
:wait
tasklist /FI "IMAGENAME eq HapsHub.exe" /NH | find /I "HapsHub.exe" >nul
if not errorlevel 1 (
    timeout /t 2 /nobreak >nul
    goto wait
)

echo Building...
dotnet build "%ROOT%\VRCNext.csproj" -c Release -maxcpucount:2 -v quiet -nologo
if errorlevel 1 (
    echo.
    echo The build failed, so nothing changed. Copy the errors above into Claude.
    pause
    exit /b 1
)

echo Opening HapsHub...
start "" "%EXE%"
