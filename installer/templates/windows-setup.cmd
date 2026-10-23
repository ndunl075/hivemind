@echo off
setlocal EnableExtensions
title Hivemind Setup
set "HERE=%~dp0"
if defined HIVEMIND_HOME (set "HM_HOME=%HIVEMIND_HOME%") else (set "HM_HOME=%USERPROFILE%\.hivemind")
set "RT=%HM_HOME%\runtime"
set "OLDCP="
for /f "tokens=2 delims=:" %%a in ('chcp') do set "OLDCP=%%a"
chcp 65001 >nul

echo.
echo  Hivemind Setup
echo  ==============
echo.

if not exist "%HERE%node\node.exe" goto :notextracted

rem Hooks are registered with the path of the Node that runs setup. Copy the bundled Node to a permanent place first,
rem so they keep working after this folder is moved or deleted.
if not exist "%RT%" mkdir "%RT%"
fc /b "%HERE%node\node.exe" "%RT%\node.exe" >nul 2>&1
if not errorlevel 1 goto :copied
copy /y "%HERE%node\node.exe" "%RT%\node.exe.new" >nul
if errorlevel 1 goto :copyfailed
move /y "%RT%\node.exe.new" "%RT%\node.exe" >nul
if errorlevel 1 goto :locked
:copied

rem The 8.3 short form of the path has only plain characters. Hook wrappers are read by cmd.exe in the OEM code page,
rem so a user name like "Zoe" with an accent would otherwise break them.
for %%I in ("%RT%\node.exe") do set "NODE=%%~sI"

if defined HIVEMIND_PROJECT goto :haveproject
echo Which project is this for? Drag the project folder onto this window, then press Enter.
set "PROJECT="
set /p "PROJECT=Project folder: "
goto :project
:haveproject
set "PROJECT=%HIVEMIND_PROJECT%"
:project
set "PROJECT=%PROJECT:"=%"
if not defined PROJECT goto :nofolder
cd /d "%PROJECT%"
if errorlevel 1 goto :badfolder

echo.
"%NODE%" "%HERE%app\cli\hivemind.mjs" join %*
if errorlevel 1 goto :joinfailed

echo.
"%NODE%" "%HERE%app\cli\hivemind.mjs" doctor
goto :end

:notextracted
echo This window was opened from inside the zip file. Close it, right-click the zip,
echo choose "Extract All", and run Hivemind Setup.cmd from the extracted folder.
goto :end
:copyfailed
echo Could not copy Node to "%RT%".
goto :end
:locked
del "%RT%\node.exe.new" >nul 2>&1
echo Could not replace "%RT%\node.exe": it is in use. Close Claude Code and Codex, then run this again.
goto :end
:nofolder
echo No folder given.
goto :end
:badfolder
echo Could not open that folder.
goto :end
:joinfailed
echo.
echo Setup did not finish. Read the message above, fix it, and run this again.

:end
echo.
if defined OLDCP chcp %OLDCP% >nul
if not defined HIVEMIND_NO_PAUSE pause
