@echo off
call "E:\MSVC\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if errorlevel 1 (
  echo [nb] vcvars64.bat failed
  exit /b 1
)
cd /d "%~dp0..\build"
ninja %*
