@echo off
setlocal
rem MSVC needs a UTF-8 console before it emits diagnostics, even with redirected output.
chcp 65001 >nul

set "_CNO_CMAKE="
for /f "delims=" %%I in ('where cmake.exe 2^>nul') do if not defined _CNO_CMAKE set "_CNO_CMAKE=%%I"
if defined _CNO_CMAKE goto run

set "_CNO_VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%_CNO_VSWHERE%" goto missing
for /f "usebackq delims=" %%I in (`"%_CNO_VSWHERE%" -latest -products * -find Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe`) do if not defined _CNO_CMAKE set "_CNO_CMAKE=%%I"
if not defined _CNO_CMAKE goto missing

:run
"%_CNO_CMAKE%" %*
exit /b %errorlevel%

:missing
echo CMake was not found. Install CMake or Visual Studio's CMake tools. >&2
exit /b 1
