@echo off
setlocal EnableExtensions
title Hivemind Setup
rem Runs hidden, from the temporary folder hivemind-setup.exe unpacks into, which Windows deletes when this exits.
rem Unpack the bundle somewhere permanent first, then open the setup window from there.
if not defined LOCALAPPDATA goto :unpackfailed
set "DEST=%LOCALAPPDATA%\Hivemind"
rem Windows' own tar reads zips; a Git or MSYS tar earlier on PATH does not.
set "TAR=%SystemRoot%\System32\tar.exe"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%TAR%" goto :unpackfailed
if not exist "%DEST%" mkdir "%DEST%"

rem Unpack next to the current copy and swap only once the new one is complete.
if exist "%DEST%\new" rmdir /s /q "%DEST%\new"
mkdir "%DEST%\new"
"%TAR%" -xf "%~dp0hivemind-windows.zip" -C "%DEST%\new" <nul
if errorlevel 1 goto :unpackfailed
if not exist "%DEST%\new\Hivemind\setup-window.ps1" goto :unpackfailed
if exist "%DEST%\Hivemind" rmdir /s /q "%DEST%\Hivemind"
if exist "%DEST%\Hivemind" goto :inuse
move "%DEST%\new\Hivemind" "%DEST%\Hivemind" >nul
if errorlevel 1 goto :inuse
rmdir "%DEST%\new"

rem -ExecutionPolicy Bypass applies to this one PowerShell process only; it changes no system setting.
"%PS%" -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%DEST%\Hivemind\setup-window.ps1"
if errorlevel 1 goto :windowfailed
exit /b 0

:windowfailed
set "MSG=The Hivemind setup window could not run on this computer. Download hivemind-windows.zip instead, extract it, and run Hivemind Setup.cmd."
goto :fail

:unpackfailed
set "MSG=Could not unpack Hivemind into your AppData folder. Download hivemind-windows.zip instead, extract it, and run Hivemind Setup.cmd."
goto :fail
:inuse
set "MSG=Could not replace the previous copy of Hivemind because a file in it is open. Close any window using it and run this again."
:fail
if defined HIVEMIND_NO_PAUSE goto :failtext
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:MSG, 'Hivemind Setup')"
exit /b 1
:failtext
echo %MSG%
exit /b 1
