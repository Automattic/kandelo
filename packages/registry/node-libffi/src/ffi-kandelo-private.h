#ifndef KANDELO_FFI_PRIVATE_H
#define KANDELO_FFI_PRIVATE_H

#include <ffi.h>

// Generated Wasm call adapters have resources beyond the portable ffi_cif.
// Only backend/bridge integration uses these declarations; keep upstream
// ffi.h unchanged and retire resources from the original Node owner.
#ifdef __cplusplus
extern "C" {
#endif
FFI_API void ffi_kandelo_release_cif(ffi_cif* cif);
FFI_API const char* ffi_kandelo_last_error(void);
#ifdef __cplusplus
}
#endif

#endif
