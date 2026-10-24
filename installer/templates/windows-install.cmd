@echo off
setlocal EnableExtensions
title Hivemind Setup
rem Runs from the temporary folder hivemind-setup.exe unpacks into, which Windows deletes when this window closes.
rem Unpack the bundle somewhere permanent first, then run the usual setup from there.
if not defined LOCALAPPDATA goto :unpackfailed
set "DEST=%LOCALAPPDATA%\Hivemind"
rem Windows' own tar reads zips; a Git or MSYS tar earlier on PATH does not.
set "TAR=%SystemRoot%\System32\tar.exe"
if not exist "%TAR%" goto :unpackfailed
if not exist "%DEST%" mkdir "%DEST%"

rem Unpack next to the current copy and swap only once the new one is complete.
if exist "%DEST%\new" rmdir /s /q "%DEST%\new"
mkdir "%DEST%\new"
"%TAR%" -xf "%~dp0hivemind-windows.zip" -C "%DEST%\new" <nul
if errorlevel 1 goto :unpackfailed
if not exist "%DEST%\new\Hivemind\Hivemind Setup.cmd" goto :unpackfailed
if exist "%DEST%\Hivemind" rmdir /s /q "%DEST%\Hivemind"
if exist "%DEST%\Hivemind" goto :inuse
move "%DEST%\new\Hivemind" "%DEST%\Hivemind" >nul
if errorlevel 1 goto :inuse
rmdir "%DEST%\new"

call "%DEST%\Hivemind\Hivemind Setup.cmd" %*
exit /b %errorlevel%

:unpackfailed
echo.
echo Could not unpack Hivemind into "%LOCALAPPDATA%\Hivemind".
echo Download hivemind-windows.zip instead, extract it, and run Hivemind Setup.cmd.
goto :fail
:inuse
echo.
echo Could not replace the previous copy in "%DEST%\Hivemind": a file in it is open.
echo Close any window using it and run this again.
:fail
echo.
if not defined HIVEMIND_NO_PAUSE pause
exit /b 1
