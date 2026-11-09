@echo off
rem Builds a self-contained copy that keeps all its data in a Data folder beside the exe.
rem It still needs Microsoft's WebView2 runtime, which Windows 10 and 11 normally have.
setlocal
set "OUT=%~dp0..\..\bin\Portable\HapsHub"
dotnet publish "%~dp0..\..\VRCNext.csproj" -c Release -r win-x64 --self-contained true -o "%OUT%" || exit /b 1
echo This file makes HapsHub keep its data in the Data folder beside it.> "%OUT%\portable.txt"
echo.
echo Portable build: %OUT%
