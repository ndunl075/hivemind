@echo off
setlocal EnableExtensions
title Hivemind Setup
rem Runs from the temporary folder hivemind-setup.exe unpacks into, which Windows deletes when this window closes.
rem Unpack the bundle somewhere permanent first, then run the usual setup from there.
set "DEST=%LOCALAPPDATA%\Hivemind"
if not exist "%DEST%" mkdir "%DEST%"
if exist "%DEST%\Hivemind" rmdir /s /q "%DEST%\Hivemind"
tar -xf "%~dp0hivemind-windows.zip" -C "%DEST%" <nul
if errorlevel 1 goto :unpackfailed
call "%DEST%\Hivemind\Hivemind Setup.cmd" %*
exit /b %errorlevel%

:unpackfailed
echo.
echo Could not unpack Hivemind into "%DEST%".
echo Download hivemind-windows.zip instead, extract it, and run Hivemind Setup.cmd.
echo.
if not defined HIVEMIND_NO_PAUSE pause
exit /b 1
