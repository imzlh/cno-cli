# cmake/stage_dlls.cmake — run via `cmake -P`
# Globs *.dll under SRC_DIR and copies them to DST_DIR.
#
# Used to mirror the runtime DLLs that vcpkg's applocal post-build step
# placed alongside cjs-cli.exe into our stage/ directory.

if(NOT DEFINED SRC_DIR OR NOT DEFINED DST_DIR)
    message(FATAL_ERROR "stage_dlls.cmake: SRC_DIR and DST_DIR must both be set")
endif()

file(MAKE_DIRECTORY "${DST_DIR}")
file(GLOB _dlls "${SRC_DIR}/*.dll")
list(LENGTH _dlls _n)
foreach(_dll IN LISTS _dlls)
    file(COPY "${_dll}" DESTINATION "${DST_DIR}")
endforeach()
message(STATUS "Staged ${_n} DLL(s) from ${SRC_DIR}")
