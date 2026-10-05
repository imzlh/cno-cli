# Use an explicit vcpkg checkout, or the copy bundled with Visual Studio.
# Keep this path stable when Visual Studio is reinstalled elsewhere.
list(APPEND CMAKE_TRY_COMPILE_PLATFORM_VARIABLES VCPKG_ROOT)
set(_cno_vcpkg_toolchain "")
foreach(_cno_vcpkg_root IN ITEMS "${VCPKG_ROOT}" "$ENV{VCPKG_ROOT}")
    if(EXISTS "${_cno_vcpkg_root}/scripts/buildsystems/vcpkg.cmake")
        set(_cno_vcpkg_toolchain "${_cno_vcpkg_root}/scripts/buildsystems/vcpkg.cmake")
        break()
    endif()
endforeach()

if(NOT _cno_vcpkg_toolchain AND CMAKE_HOST_WIN32)
    find_program(_cno_vswhere NAMES vswhere.exe
        HINTS "$ENV{ProgramFiles\(x86\)}/Microsoft Visual Studio/Installer")
    if(_cno_vswhere)
        execute_process(
            COMMAND "${_cno_vswhere}" -latest -products *
                -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64
                -find VC/vcpkg/scripts/buildsystems/vcpkg.cmake
            OUTPUT_VARIABLE _cno_vcpkg_toolchain
            OUTPUT_STRIP_TRAILING_WHITESPACE)
    endif()
endif()

if(NOT EXISTS "${_cno_vcpkg_toolchain}")
    message(FATAL_ERROR
        "vcpkg not found. Set VCPKG_ROOT to a vcpkg checkout, or install Visual Studio's vcpkg component.")
endif()

get_filename_component(_cno_project_root "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
set(VCPKG_MANIFEST_DIR "${_cno_project_root}" CACHE PATH "Project dependency manifest")
set(VCPKG_INSTALLED_DIR "${_cno_project_root}/vcpkg_installed" CACHE PATH "Project native dependencies")
include("${_cno_vcpkg_toolchain}")
