# Stand in for qtbase's own src/tools/qtwaylandscanner build on a host where
# qtbase declined to run it, and reproduce the Qt6WaylandScannerTools package
# a Qt cross-build then looks for under QT_HOST_PATH
# (QtToolHelpers.cmake:686). flake.nix states which hosts those are.
#
# The tool is one 1332-line source over QtCore alone, so this compiles it
# directly rather than configuring a second, native qtbase.

cmake_minimum_required(VERSION 3.16)

project(qtwaylandscanner LANGUAGES CXX)

find_package(Qt6 REQUIRED COMPONENTS Core)

set(scanner_dir "${QTBASE_SRC}/src/tools/qtwaylandscanner")
set(cmake_dir "lib/cmake/Qt6WaylandScannerTools")

add_executable(qtwaylandscanner "${scanner_dir}/qtwaylandscanner.cpp")
target_link_libraries(qtwaylandscanner PRIVATE Qt6::Core)

install(TARGETS qtwaylandscanner
  EXPORT Qt6WaylandScannerToolsTargets
  RUNTIME DESTINATION libexec)
install(EXPORT Qt6WaylandScannerToolsTargets
  NAMESPACE Qt6::
  DESTINATION "${cmake_dir}")

# The scanner alone is not enough: qt6_generate_wayland_protocol_*_sources
# lives beside it and is what qtwayland's CMakeLists actually calls. qtbase
# ships both through the tool's EXTRA_CMAKE_FILES.
install(FILES
    "${scanner_dir}/Qt6WaylandClientMacros.cmake"
    "${scanner_dir}/Qt6WaylandCompositorMacros.cmake"
  DESTINATION "${cmake_dir}")

include(CMakePackageConfigHelpers)

# A host tool is consumed by a cross-build of a different pointer width, and
# write_basic_package_version_file bakes CMAKE_SIZEOF_VOID_P into a bitness
# check that then rejects the package — "version: 6.10.2 (64bit)" against a
# wasm32 consumer. Clearing the variable is CMake's documented way to omit
# that check. Qt's own tools packages carry none either.
#
# Exact, because the generated glue matches one Qt and the cross-build asks
# for its own version by number.
set(CMAKE_SIZEOF_VOID_P "")
write_basic_package_version_file(
  "${CMAKE_CURRENT_BINARY_DIR}/Qt6WaylandScannerToolsConfigVersion.cmake"
  VERSION "${Qt6_VERSION}"
  COMPATIBILITY ExactVersion)

file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/Qt6WaylandScannerToolsConfig.cmake" [[
if(NOT DEFINED Qt6WaylandScannerTools_FOUND)
  set(Qt6WaylandScannerTools_FOUND TRUE)
endif()

if(NOT QT_NO_CREATE_TARGETS AND Qt6WaylandScannerTools_FOUND)
  include("${CMAKE_CURRENT_LIST_DIR}/Qt6WaylandScannerToolsTargets.cmake")
endif()

include("${CMAKE_CURRENT_LIST_DIR}/Qt6WaylandClientMacros.cmake")
include("${CMAKE_CURRENT_LIST_DIR}/Qt6WaylandCompositorMacros.cmake")

if(TARGET Qt6::qtwaylandscanner AND COMMAND __qt_internal_promote_target_to_global)
  __qt_internal_promote_target_to_global(Qt6::qtwaylandscanner)
endif()
]])

install(FILES
    "${CMAKE_CURRENT_BINARY_DIR}/Qt6WaylandScannerToolsConfig.cmake"
    "${CMAKE_CURRENT_BINARY_DIR}/Qt6WaylandScannerToolsConfigVersion.cmake"
  DESTINATION "${cmake_dir}")
