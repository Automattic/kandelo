function(kandelo_mariadb_glue_object_flags output_variable)
  if(NOT DEFINED WASM_POSIX_MARIADB_GLUE_OBJ_DIR OR
     "${WASM_POSIX_MARIADB_GLUE_OBJ_DIR}" STREQUAL "")
    message(FATAL_ERROR
      "WASM_POSIX_MARIADB_GLUE_OBJ_DIR must name the prepared glue directory")
  endif()
  if(NOT IS_ABSOLUTE "${WASM_POSIX_MARIADB_GLUE_OBJ_DIR}")
    message(FATAL_ERROR
      "WASM_POSIX_MARIADB_GLUE_OBJ_DIR must be absolute")
  endif()

  set(channel "${WASM_POSIX_MARIADB_GLUE_OBJ_DIR}/channel_syscall.o")
  set(compiler_rt "${WASM_POSIX_MARIADB_GLUE_OBJ_DIR}/compiler_rt.o")
  foreach(object IN ITEMS "${channel}" "${compiler_rt}")
    if(NOT EXISTS "${object}" OR IS_DIRECTORY "${object}" OR
       IS_SYMLINK "${object}")
      message(FATAL_ERROR "MariaDB glue object is absent: ${object}")
    endif()
  endforeach()

  set(${output_variable} "${channel} ${compiler_rt}" PARENT_SCOPE)
endfunction()
