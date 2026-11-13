cmake_minimum_required(VERSION 3.16)
project(v8-tracing VERSION 14.6.202.34 LANGUAGES CXX)
include(GNUInstallDirs)
include(CMakePackageConfigHelpers)
find_package(libuv CONFIG REQUIRED)
set(V8_SOURCE_DIR "${NODE_SOURCE_DIR}/deps/v8")
configure_file("${NODE_SOURCE_DIR}/src/node_mutex.h" private/node_mutex.h COPYONLY)
add_library(v8-tracing STATIC
  "${V8_SOURCE_DIR}/src/libplatform/tracing/trace-buffer.cc"
  "${V8_SOURCE_DIR}/src/libplatform/tracing/trace-config.cc"
  "${V8_SOURCE_DIR}/src/libplatform/tracing/trace-object.cc"
  "${V8_SOURCE_DIR}/src/libplatform/tracing/trace-writer.cc"
  "${V8_SOURCE_DIR}/src/libplatform/tracing/tracing-controller.cc"
  "${V8_SOURCE_DIR}/src/base/abort-mode.cc"
  "${V8_SOURCE_DIR}/src/base/logging.cc"
  ../src/platform.cpp)
target_compile_features(v8-tracing PUBLIC cxx_std_20)
target_compile_definitions(v8-tracing PUBLIC V8_PLATFORM_KANDELO=1
  PRIVATE _GNU_SOURCE NODE_WANT_INTERNALS=1)
target_compile_options(v8-tracing PRIVATE -fno-exceptions -fno-rtti)
target_include_directories(v8-tracing PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/../src/include" "${CMAKE_CURRENT_BINARY_DIR}/private"
  "${V8_SOURCE_DIR}" "${V8_SOURCE_DIR}/include"
  INTERFACE "$<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>")
target_link_libraries(v8-tracing PUBLIC libuv::uv_a)
install(TARGETS v8-tracing EXPORT v8-tracingTargets ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR})
install(FILES "${V8_SOURCE_DIR}/include/libplatform/v8-tracing.h"
  "${V8_SOURCE_DIR}/include/libplatform/libplatform-export.h" DESTINATION include/libplatform)
install(FILES "${V8_SOURCE_DIR}/include/v8-platform.h"
  "${V8_SOURCE_DIR}/include/v8-source-location.h" "${V8_SOURCE_DIR}/include/v8config.h" DESTINATION include)
install(EXPORT v8-tracingTargets NAMESPACE v8-tracing:: DESTINATION lib/cmake/v8-tracing)
configure_package_config_file(v8-tracingConfig.cmake.in "${CMAKE_CURRENT_BINARY_DIR}/v8-tracingConfig.cmake"
  INSTALL_DESTINATION lib/cmake/v8-tracing)
write_basic_package_version_file("${CMAKE_CURRENT_BINARY_DIR}/v8-tracingConfigVersion.cmake"
  VERSION ${PROJECT_VERSION} COMPATIBILITY SameMajorVersion)
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/v8-tracingConfig.cmake"
  "${CMAKE_CURRENT_BINARY_DIR}/v8-tracingConfigVersion.cmake" DESTINATION lib/cmake/v8-tracing)
configure_file(v8-tracing.pc.in "${CMAKE_CURRENT_BINARY_DIR}/v8-tracing.pc" @ONLY)
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/v8-tracing.pc" DESTINATION lib/pkgconfig)
install(FILES "${V8_SOURCE_DIR}/LICENSE" DESTINATION share/doc/v8-tracing RENAME LICENSE-v8)
install(FILES "${NODE_SOURCE_DIR}/LICENSE" DESTINATION share/doc/v8-tracing RENAME LICENSE-node)
