# ─────────────────────────────────────────────────────────────────────────────
# cno-cli — top-level build orchestrator
#
# Builds:
#   1. circu.js runtime           → cjs (target)
#   2. host cjsc compiler         → cjsc (target)
#   3. cno-cli bundle             → dist/cno-cli.js  (via `pnpm run bundle`)
#                                   The bundle includes the cno polyfill
#                                   (src/main.ts: `import '../cno/src/main'`).
#   4. final cno binary           = cjs + self-attached cno-cli bytecode
#
# Native extensions (ext-h2, ext-quic) can be handled three ways:
#
#   (1) Statically embedded (default for ext-h2):
#       Set -DCNO_EMBED_EXT_H2=ON / -DCNO_EMBED_EXT_QUIC=ON. The extension's
#       .c file is compiled directly into libcjs via the CJS_EXTRA_* hooks
#       in circu.js's CMakeLists. No .so/.dll needed at runtime.
#
#   (2) Pre-built shared libraries:
#       Build the extensions standalone via their own CMakeLists, then pass
#       -DCNO_EXT_DIR=/path/to/built/.so-or-dll-files. CMake will stage them
#       into stage/ext/. At runtime src/bootstrap.ts registers them via
#       import.meta.register.
#
#   (3) None: leave both off — cno still runs, just without those modules.
#
# (1) and (2) are mutually independent — you can do either, both, or neither.
# circu.js's dlopen/import.meta.register machinery stays available regardless,
# so other projects depending on circu.js can still ship dynamic extensions.
#
# Output layout (under ${CMAKE_BINARY_DIR}/stage/):
#   cno[.exe]                     ← runtime + attached bytecode (polyfill embedded)
#   ext/*{.so|.dll|.dylib}        ← native extensions (staged from CNO_EXT_DIR)
#
# ASSUMPTIONS:
#   - Building for host platform (no cross). For cross, pre-build cjsc on host
#     and pass -DCNO_HOST_CJSC=/abs/path/to/cjsc.
#   - Node.js + pnpm available on PATH for the bundling steps.
# ─────────────────────────────────────────────────────────────────────────────

cmake_minimum_required(VERSION 3.16)
project(cno-cli LANGUAGES C)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ─── Options ────────────────────────────────────────────────────────────────
option(CNO_RELEASE        "Release build: enable CJS_USE_SYMBOL_INTERNAL, strip"   OFF)
option(CNO_BUNDLE_MINIFY  "Minify the cno-cli JS bundle"                           OFF)
option(CNO_SKIP_PNPM      "Skip pnpm install (assume node_modules already present)" OFF)
option(CNO_EMBED_EXT_QUIC "Statically link the QUIC extension into cno"            OFF)

set(CNO_HOST_CJSC "" CACHE FILEPATH
    "Absolute path to a pre-built host cjsc binary (for cross-compile). Empty = build locally.")

set(CNO_EXT_DIR "" CACHE PATH
    "Directory containing pre-built native extensions (.so/.dll/.dylib). \
Files matching the platform's shared-library suffix are staged into stage/ext/. \
Independent from the CNO_EMBED_* options — use this for extensions you want \
shipped alongside cno as loadable .so files.")

# ─── Resolve & inject static extensions (BEFORE add_subdirectory(circu.js)) ─
# We populate the circu.js generic CJS_EXTRA_* hooks. circu.js doesn't know
# about cno — it just compiles whatever we hand it into libcjs and adds the
# named init functions to its static module table.
set(_CNO_EXTRA_SOURCES "")
set(_CNO_EXTRA_INCLUDES "")
set(_CNO_EXTRA_LIBS "")
set(_CNO_EXTRA_NAMES "")
set(_CNO_EXTRA_INITS "")
set(_CNO_EXTRA_SAFE "")


if(CNO_EMBED_EXT_H2)
    # nghttp2 → vcpkg provides nghttp2::nghttp2 (CONFIG mode) on Windows;
    # pkg-config provides it on Linux/macOS. Try CONFIG first, fall back.
    find_package(nghttp2 CONFIG QUIET)
    if(NOT nghttp2_FOUND)
        find_package(PkgConfig REQUIRED)
        pkg_check_modules(NGHTTP2 REQUIRED IMPORTED_TARGET libnghttp2)
        set(_NGHTTP2_TARGET PkgConfig::NGHTTP2)
    else()
        set(_NGHTTP2_TARGET nghttp2::nghttp2)
    endif()

    list(APPEND _CNO_EXTRA_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/http/ext-h2/http2.c")
    list(APPEND _CNO_EXTRA_INCLUDES "${CMAKE_CURRENT_SOURCE_DIR}/http/ext-h2")
    list(APPEND _CNO_EXTRA_LIBS "${_NGHTTP2_TARGET}")
    list(APPEND _CNO_EXTRA_NAMES "@cnojs/http/ext-h2")
    list(APPEND _CNO_EXTRA_INITS "h2_ns_init")
    list(APPEND _CNO_EXTRA_SAFE  "false")
    message(STATUS "Embedding ext-h2 (nghttp2 = ${_NGHTTP2_TARGET})")
endif()

if(CNO_EMBED_EXT_QUIC)
    # quicly + picotls come from ext-quic/deps/quicly (submodule). Build them
    # in-tree so cno-cli pulls them as transitive deps of libcjs.
    set(_QUICLY_SRC "${CMAKE_CURRENT_SOURCE_DIR}/ext-quic/deps/quicly")
    if(NOT EXISTS "${_QUICLY_SRC}/CMakeLists.txt")
        message(FATAL_ERROR
            "CNO_EMBED_EXT_QUIC=ON but ${_QUICLY_SRC}/CMakeLists.txt is missing.\n"
            "Run: cd ext-quic && git submodule update --init --recursive")
    endif()
    find_package(OpenSSL REQUIRED)
    add_subdirectory("${_QUICLY_SRC}" "${CMAKE_BINARY_DIR}/quicly")

    list(APPEND _CNO_EXTRA_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/ext-quic/native.c")
    list(APPEND _CNO_EXTRA_INCLUDES
        "${CMAKE_CURRENT_SOURCE_DIR}/ext-quic"
        "${_QUICLY_SRC}/include"
        "${_QUICLY_SRC}/deps/picotls/include")
    list(APPEND _CNO_EXTRA_LIBS quicly picotls-core picotls-openssl OpenSSL::SSL OpenSSL::Crypto)
    list(APPEND _CNO_EXTRA_NAMES "@cnojs/quic")
    list(APPEND _CNO_EXTRA_INITS "qc_ns_init")
    list(APPEND _CNO_EXTRA_SAFE  "false")
    message(STATUS "Embedding ext-quic (in-tree quicly + picotls)")
endif()

if(_CNO_EXTRA_SOURCES)
    set(CJS_EXTRA_SOURCES            "${_CNO_EXTRA_SOURCES}"  CACHE INTERNAL "")
    set(CJS_EXTRA_INCLUDE_DIRS       "${_CNO_EXTRA_INCLUDES}" CACHE INTERNAL "")
    set(CJS_EXTRA_LIBS               "${_CNO_EXTRA_LIBS}"     CACHE INTERNAL "")
    set(CJS_EXTRA_DEFINES            "CJS_STATIC_LINK"        CACHE INTERNAL "")
    set(CJS_EXTRA_MODULE_NAMES       "${_CNO_EXTRA_NAMES}"    CACHE INTERNAL "")
    set(CJS_EXTRA_MODULE_INITS       "${_CNO_EXTRA_INITS}"    CACHE INTERNAL "")
    set(CJS_EXTRA_MODULE_WORKER_SAFE "${_CNO_EXTRA_SAFE}"     CACHE INTERNAL "")
endif()

# ─── circu.js (runtime + host cjsc) ─────────────────────────────────────────
# cno always feeds the cno-cli bundle to cjsc → bytecode, and qjs bytecode
# rejects `import.meta.*`. Our bundler replaces those with __cno_use__ /
# __cno_register__ bound to globalThis[Symbol.for("cjs.internal.use"|"...register")],
# which only exist when CJS_USE_SYMBOL_INTERNAL is ON. So force it on
# unconditionally — independent of CNO_RELEASE.
set(CJS_USE_SYMBOL_INTERNAL ON CACHE BOOL "" FORCE)
# ASan defaults to ON in circu.js Debug builds; that pulls in
# clang_rt.asan_dynamic-x86_64.dll from MSVC's install dir, which vcpkg's
# applocal can't see. For cno (a distributable binary) we don't want it.
# Override if the user really wants ASan: pass -DENABLE_ASAN=ON.
set(ENABLE_ASAN OFF CACHE BOOL "" FORCE)
add_subdirectory(circu.js)

# cjsc is target-level EXCLUDE_FROM_ALL inside circu.js so it doesn't get
# built unless someone depends on it. Our bundling step does — pull it in.
if(TARGET cjsc)
    set_target_properties(cjsc PROPERTIES EXCLUDE_FROM_ALL FALSE)
endif()

# ─── External tools ─────────────────────────────────────────────────────────
find_program(PNPM_EXE NAMES pnpm pnpm.cmd)
if(NOT PNPM_EXE)
    message(FATAL_ERROR "pnpm not found on PATH — install pnpm first.")
endif()

# Host cjsc (use override if provided, else build target).
if(CNO_HOST_CJSC)
    set(_CJSC_CMD "${CNO_HOST_CJSC}")
    set(_CJSC_DEPENDS "")
else()
    set(_CJSC_CMD "$<TARGET_FILE:cjsc>")
    set(_CJSC_DEPENDS cjsc)
endif()

# ─── Step 0: pnpm install ───────────────────────────────────────────────────
set(_NM_STAMP "${CMAKE_CURRENT_SOURCE_DIR}/node_modules/.cmake-installed")
if(NOT CNO_SKIP_PNPM)
    add_custom_command(
        OUTPUT  "${_NM_STAMP}"
        COMMAND "${PNPM_EXE}" install --frozen-lockfile=false
        COMMAND "${CMAKE_COMMAND}" -E touch "${_NM_STAMP}"
        DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/package.json"
                "${CMAKE_CURRENT_SOURCE_DIR}/pnpm-workspace.yaml"
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        COMMENT "pnpm install (workspace)"
        VERBATIM)
    add_custom_target(cno-pnpm-install DEPENDS "${_NM_STAMP}")
else()
    add_custom_target(cno-pnpm-install)
endif()

# ─── Step 1/2: cno-cli bundle  (`pnpm run bundle` or `bundle:min`) ────────────
set(_CLI_BUNDLE "${CMAKE_CURRENT_SOURCE_DIR}/dist/cno-cli.js")

if(CNO_BUNDLE_MINIFY)
    set(_BUNDLE_SCRIPT "bundle:min")
    set(_CLI_BUNDLE    "${CMAKE_CURRENT_SOURCE_DIR}/dist/cno-cli.min.js")
else()
    set(_BUNDLE_SCRIPT "bundle")
endif()

file(GLOB_RECURSE _CLI_SRCS CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/src/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/cts/src/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/cno/src/*.ts"
    "${CMAKE_CURRENT_SOURCE_DIR}/http/src/*.ts")
add_custom_command(
    OUTPUT  "${_CLI_BUNDLE}"
    COMMAND "${PNPM_EXE}" run "${_BUNDLE_SCRIPT}"
    DEPENDS ${_CLI_SRCS} cno-pnpm-install
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
    COMMENT "pnpm run ${_BUNDLE_SCRIPT} → ${_CLI_BUNDLE}"
    VERBATIM)
add_custom_target(cno-cli-bundle DEPENDS "${_CLI_BUNDLE}")

# ─── Step 3: assemble the final `cno` binary ────────────────────────────────
set(_STAGE_DIR "${CMAKE_CURRENT_BINARY_DIR}/stage")
if(WIN32)
    set(_CNO_OUTPUT "${_STAGE_DIR}/cno.exe")
else()
    set(_CNO_OUTPUT "${_STAGE_DIR}/cno")
endif()

if(CNO_RELEASE)
    set(_CJSC_STRIP "-ss")    # -ss: strip source AND debug info (smallest bytecode)
else()
    set(_CJSC_STRIP "-s")     # -s:  strip source only (keep debug)
endif()

# ─── Bytecode blob: compile JS → raw .jsc, embed at link time ───────────────
set(_BLOB_PATH "${CMAKE_CURRENT_BINARY_DIR}/cno-cli.jsc")

add_custom_command(
    OUTPUT  "${_BLOB_PATH}"
    COMMAND "${_CJSC_CMD}" -m ${_CJSC_STRIP} -n "cno-cli.js"
            -o "${_BLOB_PATH}" "${_CLI_BUNDLE}"
    DEPENDS ${_CJSC_DEPENDS} cno-cli-bundle "${_CLI_BUNDLE}"
    COMMENT "Compiling JS bundle → bytecode blob ${_BLOB_PATH}"
    VERBATIM)
add_custom_target(cno-blob DEPENDS "${_BLOB_PATH}")

if(MSVC)
    set(_RC_FILE "${CMAKE_CURRENT_BINARY_DIR}/cno_blob.rc")
    file(WRITE "${_RC_FILE}" "CJS_CORE RCDATA \"${_BLOB_PATH}\"\n")
    target_sources(cjs-cli PRIVATE "${_RC_FILE}")
    target_compile_definitions(libcjs PUBLIC CJS_BLOB_RCDATA)
    add_dependencies(cjs-cli cno-blob)
else()
    set(_BLOB_S "${CMAKE_CURRENT_SOURCE_DIR}/circu.js/src/binary_blob.S")
    target_sources(libcjs PRIVATE "${_BLOB_S}")
    set(_BLOB_PATH_ESC "\"${_BLOB_PATH}\"")
    set_property(SOURCE "${_BLOB_S}" APPEND PROPERTY
        COMPILE_OPTIONS "-DCJS_BLOB_PATH=${_BLOB_PATH_ESC}")
    target_compile_definitions(libcjs PUBLIC CJS_BLOB_INCBIN)
    set_property(SOURCE "${_BLOB_S}" APPEND PROPERTY
        OBJECT_DEPENDS "${_BLOB_PATH}")
endif()

# cno binary is just a copy of cjs-cli (blob already baked in)
add_custom_command(
    OUTPUT  "${_CNO_OUTPUT}"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${_STAGE_DIR}/lib"
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${_STAGE_DIR}/ext"
    COMMAND "${CMAKE_COMMAND}" -E copy "$<TARGET_FILE:cjs-cli>" "${_CNO_OUTPUT}"
    DEPENDS cjs-cli cno-blob
    COMMENT "Staging cno binary at ${_CNO_OUTPUT}"
    VERBATIM)

# ─── Stage runtime-dependency DLLs alongside cno.exe (Windows) ──────────────
# vcpkg's applocal post-build step copies every transitive runtime DLL next
# to cjs-cli.exe at build time. We just mirror that directory into stage/
# so cno.exe (which is cjs-cli.exe + attached bytecode) can find them too.
# Done via a -P helper so the glob runs at build time, not configure time
# (the multi-config $<TARGET_FILE_DIR:cjs-cli> only resolves then).
set(_RUNTIME_DLLS_STAMP "${_STAGE_DIR}/.runtime-dlls.stamp")
if(WIN32)
    add_custom_command(
        OUTPUT  "${_RUNTIME_DLLS_STAMP}"
        COMMAND "${CMAKE_COMMAND}"
                "-DSRC_DIR=$<TARGET_FILE_DIR:cjs-cli>"
                "-DDST_DIR=${_STAGE_DIR}"
                -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/stage_dlls.cmake"
        COMMAND "${CMAKE_COMMAND}" -E touch "${_RUNTIME_DLLS_STAMP}"
        DEPENDS cjs-cli
        COMMENT "Mirroring runtime DLLs from cjs-cli output dir → stage/"
        VERBATIM)
else()
    add_custom_command(
        OUTPUT  "${_RUNTIME_DLLS_STAMP}"
        COMMAND "${CMAKE_COMMAND}" -E touch "${_RUNTIME_DLLS_STAMP}"
        VERBATIM)
endif()

# ─── Step 4: stage any pre-built native extensions from CNO_EXT_DIR ─────────
# Polyfill is bundled into the CLI bundle directly (src/main.ts does
# `import '../cno/src/main'`), so we no longer stage a separate
# lib/cno-polyfill.js file.
#
# Files are picked up at configure time via GLOB — re-configure after adding/removing.
set(_EXT_OUTPUTS "")
if(CNO_EXT_DIR AND EXISTS "${CNO_EXT_DIR}")
    file(GLOB _EXT_INPUTS CONFIGURE_DEPENDS
        "${CNO_EXT_DIR}/*${CMAKE_SHARED_LIBRARY_SUFFIX}")
    foreach(_extfile IN LISTS _EXT_INPUTS)
        get_filename_component(_name "${_extfile}" NAME)
        set(_staged "${_STAGE_DIR}/ext/${_name}")
        add_custom_command(
            OUTPUT  "${_staged}"
            COMMAND "${CMAKE_COMMAND}" -E make_directory "${_STAGE_DIR}/ext"
            COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${_extfile}" "${_staged}"
            DEPENDS "${_extfile}"
            COMMENT "Stage extension ${_name}"
            VERBATIM)
        list(APPEND _EXT_OUTPUTS "${_staged}")
    endforeach()
endif()

# ─── The umbrella `cno` target ──────────────────────────────────────────────
add_custom_target(cno ALL
    DEPENDS "${_CNO_OUTPUT}"
            "${_RUNTIME_DLLS_STAMP}"
            ${_EXT_OUTPUTS}
    COMMENT "cno build complete — staged at ${_STAGE_DIR}")

# ─── install() — copy stage/ to ${CMAKE_INSTALL_PREFIX} ─────────────────────
include(GNUInstallDirs)
install(PROGRAMS "${_CNO_OUTPUT}"      DESTINATION "${CMAKE_INSTALL_BINDIR}")
install(DIRECTORY "${_STAGE_DIR}/ext/" DESTINATION "${CMAKE_INSTALL_LIBDIR}/cno/ext"
        FILES_MATCHING PATTERN "*${CMAKE_SHARED_LIBRARY_SUFFIX}")
if(WIN32)
    # Runtime DLLs (vcpkg / system) need to sit next to cno.exe on Windows.
    install(DIRECTORY "${_STAGE_DIR}/" DESTINATION "${CMAKE_INSTALL_BINDIR}"
            FILES_MATCHING PATTERN "*.dll")
endif()

# ─── Status echo ────────────────────────────────────────────────────────────
message(STATUS "")
message(STATUS "cno-cli configuration:")
message(STATUS "  Build type:        ${CMAKE_BUILD_TYPE}")
message(STATUS "  CNO_RELEASE:       ${CNO_RELEASE}")
message(STATUS "  CJS_USE_SYMBOL_INTERNAL: ${CJS_USE_SYMBOL_INTERNAL} (forced, required by bundle)")
message(STATUS "  CNO_BUNDLE_MINIFY: ${CNO_BUNDLE_MINIFY}")
message(STATUS "  CNO_EMBED_EXT_H2:  ${CNO_EMBED_EXT_H2}")
message(STATUS "  CNO_EMBED_EXT_QUIC: ${CNO_EMBED_EXT_QUIC}")
message(STATUS "  pnpm:              ${PNPM_EXE}")
if(CNO_HOST_CJSC)
    message(STATUS "  host cjsc:         ${CNO_HOST_CJSC} (override)")
else()
    message(STATUS "  host cjsc:         <built locally>")
endif()
if(CNO_EXT_DIR AND EXISTS "${CNO_EXT_DIR}")
    list(LENGTH _EXT_OUTPUTS _ext_count)
    message(STATUS "  CNO_EXT_DIR:       ${CNO_EXT_DIR} (${_ext_count} extension(s))")
else()
    message(STATUS "  CNO_EXT_DIR:       <none>  (build extensions separately, set -DCNO_EXT_DIR=...)")
endif()
message(STATUS "  Stage dir:         ${_STAGE_DIR}")
message(STATUS "")
