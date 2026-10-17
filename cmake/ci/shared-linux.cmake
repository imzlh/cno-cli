# Applied after circu.js calls project(), when CMake has initialized platform
# library suffixes. In-tree targets remain STATIC via BUILD_SHARED_LIBS=OFF.
if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    message(FATAL_ERROR "shared-linux.cmake requires a Linux target")
endif()
set(CMAKE_FIND_LIBRARY_SUFFIXES ".so")
set(OPENSSL_USE_STATIC_LIBS FALSE)
set(CURL_USE_STATIC_LIBS FALSE)

# Stage cjs-cli as cno alongside lib/. DT_RPATH (rather than DT_RUNPATH) also
# applies to transitive dependencies of the copied libraries. Missing files
# fall through to the system loader's normal search directories.
set(CMAKE_INSTALL_RPATH "$ORIGIN/lib")
set(CMAKE_BUILD_WITH_INSTALL_RPATH ON)
set(CMAKE_INSTALL_RPATH_USE_LINK_PATH OFF)
add_link_options(-shared-libgcc -Wl,--disable-new-dtags)
