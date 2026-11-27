#ifndef KANDELO_FFI_ADAPTER_H
#define KANDELO_FFI_ADAPTER_H
#include <kandelo_fork_instrument.h>
#ifdef __cplusplus
extern "C" {
#endif
enum kandelo_ffi_adapter_mode {
  KANDELO_FFI_CALL_ADAPTER = 0,
  KANDELO_FFI_CALLBACK_ADAPTER = 1,
  KANDELO_FFI_RESERVE_CALLBACK = 2
};
/* Type codes are actual pinned ffi.h FFI_TYPE_* scalars. Void is valid only
 * as a result. Arrays are immutable, valid for count elements and not aliased
 * with output storage. Callback mode needs the live native closure address;
 * call/reservation modes retain no target/cif. Reservation ignores type codes.
 *
 * Output uses the same Rust-owned bytes/error/release API and statuses as the
 * instrumenter. Every successful output ran the real side-module transform;
 * it must still pass normal guest loader/fork admission. No raw generated
 * module may be substituted. Unexpected guest Rust panics/OOM remain fatal.
 * Factory/context and output ownership follow kandelo_fork_instrument.h. */
int kandelo_ffi_emit_adapter(uint32_t mode, uint32_t result_type,
    const uint32_t* argument_types, size_t count, uint32_t closure,
    uint64_t output_limit, kandelo_fork_create_spool factory, void* context,
    kandelo_fork_instrument_result** output);
#ifdef __cplusplus
}
#endif
#endif
