cmake_minimum_required(VERSION 3.20)
project(kcalc VERSION 1.0 LANGUAGES C CXX)

include(CheckIncludeFile)
include(CheckSymbolExists)
include(CheckCSourceRuns)

# Configure checks run inside Kandelo: compile, link and run tests.
check_include_file(unistd.h HAVE_UNISTD_H)
check_symbol_exists(fork unistd.h HAVE_FORK)
check_c_source_runs("int main(void) { return sizeof(void *) == 4 ? 0 : 1; }"
  POINTERS_ARE_32_BITS)
configure_file(config.h.in config.h)

# A library pkg-config describes (greeting.pc, on PKG_CONFIG_PATH).
find_package(PkgConfig REQUIRED)
pkg_check_modules(GREETING REQUIRED IMPORTED_TARGET greeting>=1.0)

add_library(ops STATIC ops.c)
target_include_directories(ops PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

# Kandelo cannot link executables against shared libraries, so CMake
# warns and builds this one as a static library (under policy CMP0164's
# NEW behavior, from cmake_minimum_required(VERSION 3.30), it refuses).
add_library(plugin SHARED plugin.c)

add_executable(calc main.cpp)
target_include_directories(calc PRIVATE ${CMAKE_CURRENT_BINARY_DIR})
target_link_libraries(calc PRIVATE ops plugin PkgConfig::GREETING)

enable_testing()
add_test(NAME sum COMMAND calc + 2 3)
set_tests_properties(sum PROPERTIES PASS_REGULAR_EXPRESSION "^5\n")
add_test(NAME product COMMAND calc "*" 6 7)
set_tests_properties(product PROPERTIES PASS_REGULAR_EXPRESSION "^42\n")
# std::map::at throws; calc catches it and reports the operator.
add_test(NAME rejects-unknown-operator COMMAND calc / 1 2)
set_tests_properties(rejects-unknown-operator PROPERTIES
  PASS_REGULAR_EXPRESSION "calc: unknown operator /")

install(TARGETS calc ops)
set(CPACK_GENERATOR TGZ)
include(CPack)
