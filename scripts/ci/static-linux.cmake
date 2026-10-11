# Included at the end of project(cjs), before its dependency discovery. CMake's
# platform initialization has finished, so .a preference applies to all native
# dependencies, including FFI, SQLite, Brotli and the FindCURL module.
set(CMAKE_FIND_LIBRARY_SUFFIXES ".a")
set(OPENSSL_USE_STATIC_LIBS TRUE)
set(CURL_USE_STATIC_LIBS TRUE)
set(CURL_NO_CURL_CMAKE TRUE)

function(_cno_link_static_dependency_closure)
    find_package(PkgConfig REQUIRED)
    execute_process(
        COMMAND "${PKG_CONFIG_EXECUTABLE}" --static --libs
            libcurl openssl sqlite3 expat libffi libbrotlidec libbrotlienc
        RESULT_VARIABLE _result
        OUTPUT_VARIABLE _libraries
        ERROR_VARIABLE _error
        OUTPUT_STRIP_TRAILING_WHITESPACE)
    if(NOT _result EQUAL 0)
        message(FATAL_ERROR "Cannot resolve static native dependencies: ${_error}")
    endif()
    separate_arguments(_link_items UNIX_COMMAND "${_libraries}")
    # CMake Find modules do not consistently propagate Libs.private. Repeat the
    # complete pkg-config closure in a group so archive ordering is unambiguous.
    target_link_libraries(libcjs PRIVATE
        "-Wl,--start-group" ${_link_items} "-Wl,--end-group")
endfunction()

cmake_language(DEFER CALL _cno_link_static_dependency_closure)
