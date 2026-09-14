@echo off
rem ============================================================
rem  Daily check-in launcher (WorkBuddy + Trae)
rem  ASCII-only content on purpose: the parent folder name is
rem  non-ASCII, so we resolve paths at runtime via %~dp0 instead
rem  of hardcoding them here.
rem ============================================================
chcp 65001 >nul 2>nul
setlocal

set "SCRIPT=%~dp0checkin.js"
set "NODE="

rem --- 1) common install locations ---
for %%N in ("C:\Program Files\nodejs\node.exe") do if exist %%N set "NODE=%%~N"
if not defined NODE for %%N in ("C:\Program Files (x86)\nodejs\node.exe") do if exist %%N set "NODE=%%~N"
if not defined NODE for %%N in ("%LOCALAPPDATA%\Programs\nodejs\node.exe") do if exist %%N set "NODE=%%~N"

rem --- 2) PATH lookup ---
if not defined NODE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"

rem --- 3) WorkBuddy managed node ---
if not defined NODE for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if not defined NODE if exist "%%~D\node.exe" if exist "%%~D\node_modules" set "NODE=%%~D\node.exe"
if not defined NODE for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if not defined NODE if exist "%%~D\node.exe" set "NODE=%%~D\node.exe"

if not defined NODE (
  echo [ERROR] Node.js not found. Please install Node.js 18 or newer.
  exit /b 127
)

if not exist "%SCRIPT%" (
  echo [ERROR] checkin.js not found at: %SCRIPT%
  exit /b 127
)

"%NODE%" "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"
exit /b %RC%
