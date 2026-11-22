/* Kandelo wasm32 target for the pinned upstream libffi portable core.
 * SPDX-License-Identifier: MIT
 */
#ifndef LIBFFI_TARGET_H
#define LIBFFI_TARGET_H
#ifndef LIBFFI_H
#error "Include ffi.h instead of ffitarget.h"
#endif
#if __SIZEOF_POINTER__ != 4
#error "The Kandelo libffi target currently requires wasm32"
#endif
typedef unsigned long ffi_arg;
typedef signed long ffi_sarg;
typedef void (*ffi_fp)(void);
typedef enum ffi_abi {
  FFI_FIRST_ABI = 0,
  FFI_KANDELO_WASM32,
  FFI_LAST_ABI,
  FFI_DEFAULT_ABI = FFI_KANDELO_WASM32
} ffi_abi;
#define FFI_KANDELO_TARGET 1
#define FFI_CLOSURES 1
#define FFI_TRAMPOLINE_SIZE 4
#define FFI_NATIVE_RAW_API 0
#define FFI_TARGET_SPECIFIC_VARIADIC 1
#define FFI_EXTRA_CIF_FIELDS void *kandelo_owner
#endif
