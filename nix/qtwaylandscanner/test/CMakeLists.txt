# Reproduce the lookup a Qt Wayland cross-build makes for its host scanner:
# QtToolHelpers.cmake:740 searches Qt6WaylandScannerTools with QT_HOST_PATH's
# lib/cmake as the only prefix and every other search path switched off.
#
# Both the tool and the two macro files it ships have to arrive, because
# Qt6WaylandClientMacros.cmake:22 is what fails the build when they do not.

cmake_minimum_required(VERSION 3.16)

project(qtwaylandscanner_probe LANGUAGES NONE)

set(CMAKE_PREFIX_PATH "$ENV{QT_HOST_PATH}/lib/cmake")

# The consumer is a wasm32 cross-build, and a package version file carrying a
# bitness check rejects one. State the consumer's pointer width so this probe
# fails the same way that build does.
set(CMAKE_SIZEOF_VOID_P 4)

find_package(Qt6WaylandScannerTools "${QT_HOST_VERSION}" REQUIRED
  NO_PACKAGE_ROOT_PATH
  NO_CMAKE_ENVIRONMENT_PATH
  NO_SYSTEM_ENVIRONMENT_PATH
  NO_CMAKE_PACKAGE_REGISTRY
  NO_CMAKE_SYSTEM_PATH
  NO_CMAKE_SYSTEM_PACKAGE_REGISTRY)

if(NOT TARGET Qt6::qtwaylandscanner)
  message(FATAL_ERROR "Qt6WaylandScannerTools declares no Qt6::qtwaylandscanner")
endif()

foreach(macro_name
    qt6_generate_wayland_protocol_client_sources
    qt6_generate_wayland_protocol_server_sources)
  if(NOT COMMAND "${macro_name}")
    message(FATAL_ERROR "Qt6WaylandScannerTools declares no ${macro_name}")
  endif()
endforeach()

# The macros drive Qt6::qtwaylandscanner and Wayland::Scanner side by side,
# and FindWaylandScanner.cmake:85 resolves the second off PATH.
find_program(wayland_scanner NAMES wayland-scanner)
if(NOT wayland_scanner)
  message(FATAL_ERROR "wayland-scanner is absent from PATH")
endif()

get_property(scanner TARGET Qt6::qtwaylandscanner PROPERTY LOCATION)
message(STATUS "QTWAYLANDSCANNER_OK ${scanner}")
