cmake_minimum_required(VERSION 3.20)

# Exercise the real helper from our pinned vcpkg checkout. In particular,
# vcpkg-make used to turn our exact-name -l:libatomic.so into -l:libatomic.
if(NOT VCPKG_ROOT)
    message(FATAL_ERROR "Pass -DVCPKG_ROOT=<pinned-vcpkg-checkout>")
endif()
get_filename_component(_repository "${CMAKE_CURRENT_LIST_DIR}/../.." ABSOLUTE)
include("${VCPKG_ROOT}/ports/vcpkg-make/vcpkg_make_common.cmake")

# Toolchain evaluation needs the target identity, but no compiler execution.
set(ENV{CNO_CROSS_ROOT} "${CMAKE_CURRENT_BINARY_DIR}/mock-cross")
set(ENV{CNO_CROSS_TRIPLE} "mips-linux-musl")
set(ENV{CNO_CROSS_PROCESSOR} "mips")
set(ENV{CNO_CROSS_SYSROOT} "${CMAKE_CURRENT_BINARY_DIR}/mock-sysroot")
foreach(CNO_STATIC_LINK IN ITEMS ON OFF)
    unset(CMAKE_C_STANDARD_LIBRARIES CACHE)
    unset(CMAKE_CXX_STANDARD_LIBRARIES CACHE)
    include("${_repository}/cmake/toolchains/musl-cross.cmake")
    foreach(_language IN ITEMS C CXX)
        separate_arguments(_flags NATIVE_COMMAND "${CMAKE_${_language}_STANDARD_LIBRARIES}")
        set(_original "${_flags}")
        z_vcpkg_make_prepare_link_flags(IN_OUT_VAR _flags VCPKG_TRANSFORM_LIBS)
        if(NOT "${_flags}" STREQUAL "${_original}")
            message(FATAL_ERROR
                "vcpkg-make changed ${_language} runtime flags (static=${CNO_STATIC_LINK}):\n"
                "  before: ${_original}\n  after: ${_flags}")
        endif()
    endforeach()
endforeach()
message(STATUS "Static and dynamic runtime flags survive vcpkg-make conversion")
