cmake_minimum_required(VERSION 3.16)
project(cno-cli LANGUAGES C)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(CNO_BUNDLE_MINIFY  "Minify the JS bundle"                   OFF)
option(CNO_EMBED_EXT_H2   "Statically embed HTTP/2 extension"      OFF)
option(CNO_EMBED_EXT_QUIC "Statically embed QUIC extension"        OFF)
set(CNO_HOST_CJSC  "" CACHE FILEPATH "Pre-built host cjsc (for cross-compile)")
set(CNO_EXT_DIR    "" CACHE PATH     "Pre-built native extensions dir (.so/.dll)")

# ── Static extensions ─────────────────────────────────────────────────────────
set(_EXT_SRCS "" CACHE INTERNAL "")
set(_EXT_INCS "" CACHE INTERNAL "")
set(_EXT_LIBS "" CACHE INTERNAL "")
set(_EXT_NAMES "" CACHE INTERNAL "")
set(_EXT_INITS "" CACHE INTERNAL "")
set(_EXT_SAFE  "" CACHE INTERNAL "")

macro(_cno_add_ext name init safe src inc)
    list(APPEND _EXT_SRCS  "${src}")
    list(APPEND _EXT_INCS  "${inc}")
    list(APPEND _EXT_NAMES "${name}")
    list(APPEND _EXT_INITS "${init}")
    list(APPEND _EXT_SAFE  "${safe}")
endmacro()

if(CNO_EMBED_EXT_H2)
    find_package(nghttp2 CONFIG QUIET)
    if(nghttp2_FOUND)
        set(_NGHTTP2 nghttp2::nghttp2)
    else()
        find_package(PkgConfig REQUIRED)
        pkg_check_modules(NGHTTP2 REQUIRED IMPORTED_TARGET libnghttp2)
        set(_NGHTTP2 PkgConfig::NGHTTP2)
    endif()
    list(APPEND _EXT_LIBS "${_NGHTTP2}")
    _cno_add_ext("@cnojs/http/ext-h2" "h2_ns_init" "false"
        "${CMAKE_CURRENT_SOURCE_DIR}/http/ext-h2/http2.c"
        "${CMAKE_CURRENT_SOURCE_DIR}/http/ext-h2")
    message(STATUS "[cno] embed ext-h2 (${_NGHTTP2})")
endif()

if(CNO_EMBED_EXT_QUIC)
    set(_QUICLY "${CMAKE_CURRENT_SOURCE_DIR}/ext-quic/deps/quicly")
    if(NOT EXISTS "${_QUICLY}/CMakeLists.txt")
        message(FATAL_ERROR "CNO_EMBED_EXT_QUIC: missing submodule at ${_QUICLY}")
    endif()
    find_package(OpenSSL REQUIRED)
    add_subdirectory("${_QUICLY}" "${CMAKE_BINARY_DIR}/quicly")
    list(APPEND _EXT_LIBS quicly picotls-core picotls-openssl OpenSSL::SSL OpenSSL::Crypto)
    _cno_add_ext("@cnojs/quic" "qc_ns_init" "false"
        "${CMAKE_CURRENT_SOURCE_DIR}/ext-quic/native.c"
        "${CMAKE_CURRENT_SOURCE_DIR}/ext-quic")
    list(APPEND _EXT_INCS
        "${_QUICLY}/include"
        "${_QUICLY}/deps/picotls/include")
    message(STATUS "[cno] embed ext-quic (in-tree quicly)")
endif()

if(_EXT_SRCS)
    set(CJS_EXTRA_SOURCES            "${_EXT_SRCS}"   CACHE INTERNAL "")
    set(CJS_EXTRA_INCLUDE_DIRS       "${_EXT_INCS}"   CACHE INTERNAL "")
    set(CJS_EXTRA_LIBS               "${_EXT_LIBS}"   CACHE INTERNAL "")
    set(CJS_EXTRA_DEFINES            "CJS_STATIC_LINK" CACHE INTERNAL "")
    set(CJS_EXTRA_MODULE_NAMES       "${_EXT_NAMES}"  CACHE INTERNAL "")
    set(CJS_EXTRA_MODULE_INITS       "${_EXT_INITS}"  CACHE INTERNAL "")
    set(CJS_EXTRA_MODULE_WORKER_SAFE "${_EXT_SAFE}"   CACHE INTERNAL "")
endif()

# ── Blob path — must be resolved before add_subdirectory(circu.js) ────────────
set(_BLOB_C "${CMAKE_CURRENT_BINARY_DIR}/cno_cli_blob.c")
set(_BLOB_H "${CMAKE_CURRENT_BINARY_DIR}/cno_cli_blob.h")
set(CJS_BLOB_C "${_BLOB_C}" CACHE INTERNAL
    "Generated .c file containing bytecode as C array (cjs_blob[])")

# ── circu.js ──────────────────────────────────────────────────────────────────
set(CJS_USE_SYMBOL_INTERNAL ON CACHE BOOL "" FORCE)
set(ENABLE_ASAN ON CACHE BOOL "" FORCE)
add_subdirectory(circu.js)
if(TARGET cjsc)
    set_target_properties(cjsc PROPERTIES EXCLUDE_FROM_ALL FALSE)
endif()

# ── JS toolchain ──────────────────────────────────────────────────────────────
find_program(PNPM_EXE NAMES pnpm pnpm.cmd)
if(NOT PNPM_EXE)
    message(FATAL_ERROR "pnpm not found — install pnpm first.")
endif()

if(CNO_HOST_CJSC)
    set(_CJSC_EXE "${CNO_HOST_CJSC}")
    set(_CJSC_DEP "")
else()
    set(_CJSC_EXE "$<TARGET_FILE:cjsc>")
    set(_CJSC_DEP cjsc)
endif()

# pnpm install
set(_NM_STAMP "${CMAKE_CURRENT_BINARY_DIR}/.pnpm-installed")
add_custom_command(
    OUTPUT  "${_NM_STAMP}"
    COMMAND "${PNPM_EXE}" install --frozen-lockfile=false
    COMMAND "${CMAKE_COMMAND}" -E touch "${_NM_STAMP}"
    DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/package.json"
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    COMMENT "pnpm install"
    VERBATIM)
add_custom_target(cno-pnpm-install DEPENDS "${_NM_STAMP}")

# esbuild bundle
set(_BUNDLE_SCRIPT "bundle")
set(_CLI_BUNDLE    "${CMAKE_CURRENT_SOURCE_DIR}/dist/cno-cli.js")
if(CNO_BUNDLE_MINIFY)
    set(_BUNDLE_SCRIPT "bundle:min")
    set(_CLI_BUNDLE    "${CMAKE_CURRENT_SOURCE_DIR}/dist/cno-cli.min.js")
endif()

file(GLOB_RECURSE _CLI_SRCS CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/cts/src/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/cno/src/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/http/src/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/scripts/*.mjs")
add_custom_command(
    OUTPUT  "${_CLI_BUNDLE}"
    COMMAND "${PNPM_EXE}" run "${_BUNDLE_SCRIPT}"
    DEPENDS ${_CLI_SRCS} cno-pnpm-install
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    COMMENT "bundle → ${_CLI_BUNDLE}"
    VERBATIM)
add_custom_target(cno-cli-bundle DEPENDS "${_CLI_BUNDLE}")

# cjsc → C source (bytecode as const uint8_t cjs_blob[])
set(_STRIP_FLAG "-s")
if(CNO_RELEASE)
    set(_STRIP_FLAG "-ss")
endif()
add_custom_command(
    OUTPUT  "${_BLOB_H}"
    COMMAND "${_CJSC_EXE}" -m -N cjs_blob -n "<core>" ${_STRIP_FLAG} -o "${_BLOB_H}" "${_CLI_BUNDLE}"
    DEPENDS ${_CJSC_DEP} cno-cli-bundle "${_CLI_BUNDLE}"
    COMMENT "cjsc → ${_BLOB_H}"
    VERBATIM)

file(WRITE "${_BLOB_C}" "#include \"cno_cli_blob.h\"\n")
add_custom_target(cno-blob DEPENDS "${_BLOB_H}")

# libcjs must not compile the blob until cno-blob produces the real .c file
add_dependencies(libcjs cno-blob)

# ── Stage ─────────────────────────────────────────────────────────────────────
set(_STAGE_DIR "${CMAKE_CURRENT_BINARY_DIR}/stage")
if(WIN32)
    set(_CNO_BIN "${_STAGE_DIR}/cno.exe")
else()
    set(_CNO_BIN "${_STAGE_DIR}/cno")
endif()

add_custom_command(
    OUTPUT  "${_CNO_BIN}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${_STAGE_DIR}/lib" "${_STAGE_DIR}/ext"
    COMMAND "${CMAKE_COMMAND}" -E copy "$<TARGET_FILE:cjs-cli>" "${_CNO_BIN}"
    DEPENDS cjs-cli
    COMMENT "Stage cno → ${_STAGE_DIR}"
    VERBATIM)

# Mirror runtime DLLs from cjs-cli output dir (Windows only)
set(_DLL_STAMP "${_STAGE_DIR}/.dlls.stamp")
if(WIN32)
    add_custom_command(
        OUTPUT  "${_DLL_STAMP}"
        COMMAND "${CMAKE_COMMAND}"
                "-DSRC_DIR=$<TARGET_FILE_DIR:cjs-cli>"
                "-DDST_DIR=${_STAGE_DIR}"
                -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/stage_dlls.cmake"
        COMMAND "${CMAKE_COMMAND}" -E touch "${_DLL_STAMP}"
        DEPENDS "${_CNO_BIN}"
        COMMENT "Stage runtime DLLs"
        VERBATIM)
else()
    add_custom_command(
        OUTPUT  "${_DLL_STAMP}"
        COMMAND "${CMAKE_COMMAND}" -E touch "${_DLL_STAMP}"
        DEPENDS "${_CNO_BIN}"
        VERBATIM)
endif()

# Stage pre-built shared extensions (CNO_EXT_DIR)
set(_STAGED_EXTS "")
if(CNO_EXT_DIR AND EXISTS "${CNO_EXT_DIR}")
    file(GLOB _EXT_INPUTS CONFIGURE_DEPENDS "${CNO_EXT_DIR}/*${CMAKE_SHARED_LIBRARY_SUFFIX}")
    foreach(_f IN LISTS _EXT_INPUTS)
        get_filename_component(_name "${_f}" NAME)
        set(_dest "${_STAGE_DIR}/ext/${_name}")
        add_custom_command(
            OUTPUT  "${_dest}"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${_STAGE_DIR}/ext"
            COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${_f}" "${_dest}"
            DEPENDS "${_f}"
            COMMENT "Stage ext/${_name}"
            VERBATIM)
        list(APPEND _STAGED_EXTS "${_dest}")
    endforeach()
endif()

# ── Umbrella target ───────────────────────────────────────────────────────────
add_custom_target(cno ALL
    DEPENDS "${_DLL_STAMP}" ${_STAGED_EXTS}
    COMMENT "cno staged at ${_STAGE_DIR}")

# ── Install ───────────────────────────────────────────────────────────────────
include(GNUInstallDirs)
install(PROGRAMS "${_CNO_BIN}" DESTINATION "${CMAKE_INSTALL_BINDIR}")
install(DIRECTORY "${_STAGE_DIR}/ext/"
        DESTINATION "${CMAKE_INSTALL_LIBDIR}/cno/ext"
        FILES_MATCHING PATTERN "*${CMAKE_SHARED_LIBRARY_SUFFIX}")
if(WIN32)
    install(DIRECTORY "${_STAGE_DIR}/"
            DESTINATION "${CMAKE_INSTALL_BINDIR}"
            FILES_MATCHING PATTERN "*.dll")
endif()

# ── Status ────────────────────────────────────────────────────────────────────
if(CNO_EXT_DIR AND EXISTS "${CNO_EXT_DIR}")
    list(LENGTH _STAGED_EXTS _n)
    set(_ext_info "${CNO_EXT_DIR} (${_n} file(s))")
else()
    set(_ext_info "<none>")
endif()
message(STATUS "")
message(STATUS "[cno] stage=${_STAGE_DIR}")
message(STATUS "[cno] blob=${_BLOB_C}")
message(STATUS "[cno] release=${CNO_RELEASE}  h2=${CNO_EMBED_EXT_H2}  quic=${CNO_EMBED_EXT_QUIC}")
message(STATUS "[cno] ext_dir=${_ext_info}")
message(STATUS "")
