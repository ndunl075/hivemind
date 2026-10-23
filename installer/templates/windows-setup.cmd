@echo off
setlocal
title Hivemind Setup
set "HERE=%~dp0"
if defined HIVEMIND_HOME (set "HM_HOME=%HIVEMIND_HOME%") else (set "HM_HOME=%USERPROFILE%\.hivemind")
set "RT=%HM_HOME%\runtime"

echo.
echo  Hivemind Setup
echo  ==============
echo.

rem Hooks are registered with the path of the Node that runs setup. Copy the bundled Node to a permanent place first,
rem so they keep working after this folder is moved or deleted.
if not exist "%RT%" mkdir "%RT%"
copy /y "%HERE%node\node.exe" "%RT%\node.exe" >nul
if errorlevel 1 (
  echo Could not copy Node to %RT%
  goto :end
)

if defined HIVEMIND_PROJECT (
  set "PROJECT=%HIVEMIND_PROJECT%"
) else (
  echo Which project is this for? Drag the project folder onto this window, then press Enter.
  set "PROJECT="
  set /p "PROJECT=Project folder: "
)
set "PROJECT=%PROJECT:"=%"
if not defined PROJECT (
  echo No folder given.
  goto :end
)
cd /d "%PROJECT%"
if errorlevel 1 (
  echo Could not open the folder "%PROJECT%".
  goto :end
)

echo.
"%RT%\node.exe" "%HERE%app\cli\hivemind.mjs" join %*
if errorlevel 1 (
  echo.
  echo Setup did not finish. Read the message above, fix it, and run this again.
  goto :end
)

echo.
"%RT%\node.exe" "%HERE%app\cli\hivemind.mjs" doctor

:end
echo.
if not defined HIVEMIND_NO_PAUSE pause
