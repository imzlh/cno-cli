function(_cno_find_nghttp2)
    find_package(PkgConfig QUIET)
    if(PkgConfig_FOUND)
        pkg_check_modules(_NGHTTP2 QUIET libnghttp2)
    endif()
    if(CNO_STATIC_LINK AND UNIX)
        set(CMAKE_FIND_LIBRARY_SUFFIXES ".a")
    endif()
    find_path(CNO_NGHTTP2_INCLUDE_DIR NAMES nghttp2/nghttp2.h
        HINTS ${_NGHTTP2_INCLUDE_DIRS})
    find_library(CNO_NGHTTP2_LIBRARY_RELEASE NAMES nghttp2 HINTS ${_NGHTTP2_LIBRARY_DIRS})
    if(WIN32)
        find_library(CNO_NGHTTP2_LIBRARY_DEBUG NAMES nghttp2d
            HINTS ${_NGHTTP2_LIBRARY_DIRS})
    endif()
    if(NOT CNO_NGHTTP2_INCLUDE_DIR OR NOT CNO_NGHTTP2_LIBRARY_RELEASE)
        message(FATAL_ERROR "HTTP/2 requires nghttp2 development headers and library. "
            "Install libnghttp2-dev (Debian/Ubuntu), nghttp2-dev (Alpine), nghttp2 (Homebrew/vcpkg), "
            "or configure with -DCNO_EMBED_EXT_H2=OFF.")
    endif()
    add_library(cno_nghttp2 UNKNOWN IMPORTED)
    set_target_properties(cno_nghttp2 PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${CNO_NGHTTP2_INCLUDE_DIR}")
    set_target_properties(cno_nghttp2 PROPERTIES
        IMPORTED_LOCATION "${CNO_NGHTTP2_LIBRARY_RELEASE}")
    if(WIN32 AND (VCPKG_LIBRARY_LINKAGE STREQUAL "static" OR VCPKG_TARGET_TRIPLET MATCHES "-static($|-)"))
        set_property(TARGET cno_nghttp2 PROPERTY INTERFACE_COMPILE_DEFINITIONS NGHTTP2_STATICLIB)
    endif()
    if(CNO_NGHTTP2_LIBRARY_DEBUG)
        set_property(TARGET cno_nghttp2 APPEND PROPERTY IMPORTED_CONFIGURATIONS DEBUG)
        set_property(TARGET cno_nghttp2 PROPERTY IMPORTED_LOCATION_DEBUG "${CNO_NGHTTP2_LIBRARY_DEBUG}")
    endif()
endfunction()

_cno_find_nghttp2()
