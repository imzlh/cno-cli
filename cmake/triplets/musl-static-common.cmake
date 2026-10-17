# Keep the default aligned with musl-cross.cmake, including an empty environment
# variable. vcpkg configures these ports separately from the in-tree libraries.
set(_cno_static_link ON)
if(DEFINED ENV{CNO_STATIC_LINK} AND NOT "$ENV{CNO_STATIC_LINK}" STREQUAL "")
    set(_cno_static_link "$ENV{CNO_STATIC_LINK}")
endif()
if(_cno_static_link)
    set(VCPKG_CRT_LINKAGE static)
    set(VCPKG_LIBRARY_LINKAGE static)
else()
    set(VCPKG_CRT_LINKAGE dynamic)
    set(VCPKG_LIBRARY_LINKAGE dynamic)
endif()
set(VCPKG_CMAKE_SYSTEM_NAME Linux)
set(VCPKG_BUILD_TYPE release)
set(VCPKG_CHAINLOAD_TOOLCHAIN_FILE "${CMAKE_CURRENT_LIST_DIR}/../toolchains/musl-cross.cmake")
set(VCPKG_ENV_PASSTHROUGH
    CNO_CROSS_ROOT CNO_CROSS_TRIPLE CNO_CROSS_PROCESSOR CNO_CROSS_SYSROOT CNO_STATIC_LINK)
# Autoconf must identify the target by its compiler triple, never by the runner.
set(VCPKG_MAKE_BUILD_TRIPLET "--host=$ENV{CNO_CROSS_TRIPLE}")
