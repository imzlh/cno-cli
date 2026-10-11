set(CMAKE_SYSTEM_NAME Linux)

foreach(_var IN ITEMS CNO_CROSS_ROOT CNO_CROSS_TRIPLE CNO_CROSS_PROCESSOR CNO_CROSS_SYSROOT)
    if(NOT DEFINED ENV{${_var}} OR "$ENV{${_var}}" STREQUAL "")
        message(FATAL_ERROR "${_var} is required; use scripts/ci/build-cross-linux.sh")
    endif()
endforeach()

set(CMAKE_SYSTEM_PROCESSOR "$ENV{CNO_CROSS_PROCESSOR}")
set(_cno_cross_prefix "$ENV{CNO_CROSS_ROOT}/bin/$ENV{CNO_CROSS_TRIPLE}-")
set(CMAKE_C_COMPILER "${_cno_cross_prefix}gcc")
set(CMAKE_CXX_COMPILER "${_cno_cross_prefix}g++")
set(CMAKE_ASM_COMPILER "${_cno_cross_prefix}gcc")
set(CMAKE_AR "${_cno_cross_prefix}ar")
set(CMAKE_RANLIB "${_cno_cross_prefix}ranlib")
set(CMAKE_NM "${_cno_cross_prefix}nm")
set(CMAKE_STRIP "${_cno_cross_prefix}strip")
set(CMAKE_SYSROOT "$ENV{CNO_CROSS_SYSROOT}")
list(APPEND CMAKE_FIND_ROOT_PATH "${CMAKE_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

# Every release dependency, including libc, is linked into the executable.
set(CMAKE_EXE_LINKER_FLAGS_INIT "-static")
# QuickJS and libuv use atomics that need compiler runtime support on 32-bit CPUs.
set(CMAKE_C_STANDARD_LIBRARIES "-latomic" CACHE STRING "Compiler atomic runtime")
set(CMAKE_CXX_STANDARD_LIBRARIES "-latomic" CACHE STRING "Compiler atomic runtime")
