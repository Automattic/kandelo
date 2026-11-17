# Policy CMP0164 is NEW from 3.30: add_library(SHARED) would stop with an
# error on Kandelo, while add_library(MODULE) builds a dlopen module.
cmake_minimum_required(VERSION 3.30)
project(kandelo_plugins C)

add_executable(host host.c)
# Export the program's symbols to the modules it loads.
set_target_properties(host PROPERTIES ENABLE_EXPORTS ON)
target_link_libraries(host PRIVATE ${CMAKE_DL_LIBS})

add_library(greet MODULE plugin.c)

install(TARGETS host greet)
