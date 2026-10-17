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

# The musl.cc mipsel compiler defaults to MIPS I, which lacks the ldc1
# instructions in WAMR's native-call shim. Keep one CPU baseline for all
# languages, including C++ dependencies built by vcpkg.
if("$ENV{CNO_CROSS_TRIPLE}" STREQUAL "mipsel-linux-musl")
    set(CMAKE_C_FLAGS_INIT "-march=mips32r2")
    set(CMAKE_CXX_FLAGS_INIT "-march=mips32r2")
    set(CMAKE_ASM_FLAGS_INIT "-march=mips32r2")
endif()

# vcpkg configures ports in separate CMake processes, so it needs the exported
# environment default as well as the top-level -D option. Compiler checks must
# retain the same setting when they load this toolchain in try_compile.
if(NOT DEFINED CNO_STATIC_LINK)
    if(DEFINED ENV{CNO_STATIC_LINK} AND NOT "$ENV{CNO_STATIC_LINK}" STREQUAL "")
        set(CNO_STATIC_LINK "$ENV{CNO_STATIC_LINK}" CACHE BOOL "Link musl and external dependencies statically")
    else()
        set(CNO_STATIC_LINK ON CACHE BOOL "Link musl and external dependencies statically")
    endif()
endif()
list(APPEND CMAKE_TRY_COMPILE_PLATFORM_VARIABLES CNO_STATIC_LINK)
list(REMOVE_DUPLICATES CMAKE_TRY_COMPILE_PLATFORM_VARIABLES)

if(CNO_STATIC_LINK)
    set(CMAKE_EXE_LINKER_FLAGS_INIT "-static")
    set(_cno_atomic "-Wl,--push-state,-Bstatic -latomic -Wl,--pop-state")
else()
    # External dependencies, including compiler runtimes, stay shared. This
    # does not change BUILD_SHARED_LIBS: the in-tree runtime remains static.
    set(CMAKE_EXE_LINKER_FLAGS_INIT "-shared-libgcc")
    set(CMAKE_SHARED_LINKER_FLAGS_INIT "-shared-libgcc")
    set(CMAKE_MODULE_LINKER_FLAGS_INIT "-shared-libgcc")
    # vcpkg-make strips a trailing .so from each C_STANDARD_LIBRARIES item.
    # Keep the exact library name inside one linker argument, where it cannot
    # become -l:libatomic. This still requires shared libatomic, without an
    # implicit fallback to its static archive.
    set(_cno_atomic "-Wl,--push-state,-Bdynamic,-l:libatomic.so,--pop-state")
endif()
# QuickJS and libuv use atomics that need compiler runtime support on 32-bit CPUs.
# Restore the incoming linker state so this also works for fully static links.
set(CMAKE_C_STANDARD_LIBRARIES "${_cno_atomic}" CACHE STRING "Compiler atomic runtime")
set(CMAKE_CXX_STANDARD_LIBRARIES "${_cno_atomic}" CACHE STRING "Compiler atomic runtime")
