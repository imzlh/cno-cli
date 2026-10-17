cmake_minimum_required(VERSION 3.20)
project(cjs_ext_oxc C)

get_filename_component(CJS_OXC_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../ext-oxc" ABSOLUTE)
if(NOT EXISTS "${CJS_OXC_SOURCE_DIR}/Cargo.toml")
  message(FATAL_ERROR "Check out the ext-oxc submodule before building OXC")
endif()
# The upstream library does not track its lockfile. Release reproducibility is
# owned here so a workflow checkout needs no unpublished submodule changes.
configure_file("${CMAKE_CURRENT_SOURCE_DIR}/Cargo.lock"
               "${CJS_OXC_SOURCE_DIR}/Cargo.lock" COPYONLY)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(CJS_OXC_RUST_ARCHIVE "" CACHE FILEPATH "Prebuilt Linux Rust staticlib (skips Cargo/Corrosion)")
option(CJS_OXC_SHARED_RUNTIME "Link compiler runtimes dynamically for Linux shared dependency bundles" OFF)

# GCC and Rust triples are not interchangeable: for example GCC's
# riscv64-linux-musl maps to Rust's riscv64gc-unknown-linux-musl. The Linux CI
# helper maps these explicitly and can build Rust on the host before the C glue
# is linked inside a target container that does not have a Rust toolchain.
if(CMAKE_CROSSCOMPILING AND NOT CJS_OXC_RUST_ARCHIVE AND NOT Rust_CARGO_TARGET)
  message(FATAL_ERROR
    "Cross-compiling OXC requires -DRust_CARGO_TARGET=<rust-target-triple> "
    "or -DCJS_OXC_RUST_ARCHIVE=<target-staticlib>.")
endif()

# ---------------------------------------------------------------------------
# Path to the circu.js checkout root (the dir that contains src/ and
# deps/quickjs/). tjs.h and quickjs.h locations are derived from it, not
# passed separately, since they always live at fixed spots relative to it.
# ---------------------------------------------------------------------------
set(CJS_DIR "" CACHE PATH "Path to circu.js root (contains src/tjs.h and deps/quickjs/quickjs.h)")
if(NOT CJS_DIR)
  message(FATAL_ERROR "Set -DCJS_DIR=/path/to/circu.js")
endif()
set(CJS_SRC_DIR "${CJS_DIR}/src")
set(CJS_QUICKJS_DIR "${CJS_DIR}/deps/quickjs")
if(NOT EXISTS "${CJS_SRC_DIR}/tjs.h")
  message(FATAL_ERROR "tjs.h not found under ${CJS_SRC_DIR} — is CJS_DIR set to the circu.js root?")
endif()
if(NOT EXISTS "${CJS_QUICKJS_DIR}/quickjs.h")
  message(FATAL_ERROR "quickjs.h not found under ${CJS_QUICKJS_DIR} — is CJS_DIR set to the circu.js root?")
endif()

# ---------------------------------------------------------------------------
# 1) Build the Rust (oxc) staticlib via Corrosion.
# ---------------------------------------------------------------------------
if(CJS_OXC_RUST_ARCHIVE)
  if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    message(FATAL_ERROR "CJS_OXC_RUST_ARCHIVE is supported only for Linux builds")
  endif()
  if(NOT EXISTS "${CJS_OXC_RUST_ARCHIVE}")
    message(FATAL_ERROR "Rust staticlib not found: ${CJS_OXC_RUST_ARCHIVE}")
  endif()
  add_library(cjs_oxc_core STATIC IMPORTED)
  set_target_properties(cjs_oxc_core PROPERTIES
    IMPORTED_LOCATION "${CJS_OXC_RUST_ARCHIVE}"
    INTERFACE_LINK_LIBRARIES "dl;pthread;m;rt;util")
else()
  include(FetchContent)
  FetchContent_Declare(Corrosion
    GIT_REPOSITORY https://github.com/corrosion-rs/corrosion.git
    GIT_TAG v0.6)
  FetchContent_MakeAvailable(Corrosion)
  corrosion_import_crate(MANIFEST_PATH "${CJS_OXC_SOURCE_DIR}/Cargo.toml"
                         PROFILE release LOCKED)
  # Rust's musl targets otherwise default to a static CRT, which is unsuitable
  # for a shared module. PIC is also required on targets whose default differs.
  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    corrosion_add_target_rustflags(cjs_oxc_core -Crelocation-model=pic)
    if(Rust_CARGO_TARGET MATCHES "musl")
      corrosion_add_target_rustflags(cjs_oxc_core -Ctarget-feature=-crt-static)
    endif()
  endif()
endif()
# Crate [lib] name is cjs_oxc_core -> Corrosion target is `cjs_oxc_core`.

# ---------------------------------------------------------------------------
# 2) Build the C glue as a loadable module that links the Rust archive.
#    Output is named to match the module you register: oxc.so / oxc.dll.
# ---------------------------------------------------------------------------
add_library(cjs_ext_oxc MODULE "${CJS_OXC_SOURCE_DIR}/native/binding.c")
target_include_directories(cjs_ext_oxc PRIVATE
  "${CJS_OXC_SOURCE_DIR}/include"
  "${CJS_SRC_DIR}"
  "${CJS_QUICKJS_DIR}"
  "${CJS_DIR}/deps/libuv/include")
target_link_libraries(cjs_ext_oxc PRIVATE cjs_oxc_core)
set_target_properties(cjs_ext_oxc PROPERTIES PREFIX "" OUTPUT_NAME "oxc")
if(MSVC)
  target_compile_options(cjs_ext_oxc PRIVATE /O1)
  # qjs.dll owns the QuickJS API in Windows builds. Match the declarations in
  # the host's quickjs.h so calls are emitted through its import library.
  target_compile_definitions(cjs_ext_oxc PRIVATE USING_QJS_SHARED)
else()
  target_compile_options(cjs_ext_oxc PRIVATE -Os -ffunction-sections -fdata-sections)
endif()

# IMPORTANT: this module compiles against the host's quickjs.h. Pass the SAME
# QuickJS config flags your cno build uses (uncomment/adjust as needed):
# target_compile_definitions(cjs_ext_oxc PRIVATE)

# ---------------------------------------------------------------------------
# 3) Platform-specific symbol resolution. The module calls JS_* functions that
#    live in the cno executable, so they are intentionally left UNDEFINED here
#    and resolved from the host process at dlopen() time.
# ---------------------------------------------------------------------------
if(APPLE)
  target_link_options(cjs_ext_oxc PRIVATE -undefined dynamic_lookup)
elseif(WIN32)
  # Windows DLLs cannot have unresolved imports -> must link an import library
  # for cno.exe (and cno must export the JS_* API). See README "Windows".
  set(CNO_IMPLIB "" CACHE FILEPATH "Path to cno import library (e.g. cno.lib)")
  if(NOT CNO_IMPLIB)
    message(FATAL_ERROR "On Windows set -DCNO_IMPLIB=path\\to\\cno.lib")
  endif()
  target_link_libraries(cjs_ext_oxc PRIVATE "${CNO_IMPLIB}")
else() # Linux / other ELF
  target_link_options(cjs_ext_oxc PRIVATE -Wl,--allow-shlib-undefined,--gc-sections,-s)
  if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    # Keep Rust symbols private; the native module entry stays exported.
    target_link_options(cjs_ext_oxc PRIVATE -Wl,--exclude-libs,ALL,--disable-new-dtags)
    if(CJS_OXC_SHARED_RUNTIME)
      target_link_options(cjs_ext_oxc PRIVATE -shared-libgcc)
    else()
      target_link_options(cjs_ext_oxc PRIVATE -static-libgcc)
    endif()
    set_target_properties(cjs_ext_oxc PROPERTIES
      BUILD_WITH_INSTALL_RPATH ON
      INSTALL_RPATH "$ORIGIN/../lib"
      INSTALL_RPATH_USE_LINK_PATH OFF)
  endif()
  # Reminder: build cno itself with -rdynamic (ENABLE_EXPORTS) so JS_* are
  # visible to dlopen'd plugins.
endif()
