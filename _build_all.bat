@echo off
call "E:\MSVC\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cmake --build build -j2
