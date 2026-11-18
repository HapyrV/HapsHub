@echo off
rem Double-click this from Explorer. It opens the HapsHub update window, which waits for HapsHub to close,
rem rebuilds it and opens it again. Your data isn't touched. If the build fails, the old copy opens as it was
rem and the reason is saved in %APPDATA%\HapsHub\Logs\update-failed.log.
set "ROOT=%~dp0..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "EXE=%ROOT%\bin\Release\net10.0-windows10.0.19041.0\HapsHub.exe"
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0auto-update.ps1" -Root "%ROOT%" -Exe "%EXE%" -LogFile "%APPDATA%\HapsHub\Logs\update-failed.log" -Manual
