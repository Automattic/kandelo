#ifndef KANDELO_FORK_INSTRUMENT_H
#define KANDELO_FORK_INSTRUMENT_H
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum kandelo_fork_instrument_status {
  KANDELO_FORK_INSTRUMENT_OK = 0,
  KANDELO_FORK_INSTRUMENT_INVALID_ARGUMENT = 1,
  KANDELO_FORK_INSTRUMENT_TRANSFORM_ERROR = 2,
  KANDELO_FORK_INSTRUMENT_PANIC = 3
};
typedef struct kandelo_fork_instrument_result kandelo_fork_instrument_result;

/* Called synchronously. Transfer a fresh, empty, readable/writable, seekable
 * regular fd at offset zero, or return -1 with errno set. Transfer exclusive
 * ownership: retain no writable fd/mapping or public path. The library closes
 * all transferred fds, including on failure. In Kandelo use memfd_create with
 * MFD_CLOEXEC. The factory must not unwind; context is never retained. */
typedef int (*kandelo_fork_create_spool)(void* context);

/* Borrow immutable input until return. Output storage must be non-null and
 * not overlap input; input may be null only when input_len is zero.
 * output_limit must be positive. Requires a real dylink.0 guest side module.
 * INVALID_ARGUMENT leaves *output null. Other outcomes return one Rust-owned
 * object, including errors: always release it with this same library, never
 * C free(). No borrowed input/factory/context escapes into that object.
 *
 * PANIC applies only to unwind-enabled Rust builds. The current Kandelo Rust
 * target aborts on unexpected panics/OOM; this API does not make them catchable.
 * Normal validation, storage and transformation errors use TRANSFORM_ERROR. */
int kandelo_fork_instrument_side_module(
    const uint8_t* input, size_t input_len, uint64_t output_limit,
    kandelo_fork_create_spool create_spool, void* context,
    kandelo_fork_instrument_result** output);

/* Borrowed immutable output/error remains valid only until release. On error,
 * bytes returns null/length zero. On success, error returns null. Null result
 * is accepted. length must point to writable size_t storage. */
const uint8_t* kandelo_fork_instrument_bytes(
    const kandelo_fork_instrument_result* result, size_t* length);
const char* kandelo_fork_instrument_error(
    const kandelo_fork_instrument_result* result);
/* Null is accepted. Release once, after all borrowed/concurrent access ends. */
void kandelo_fork_instrument_release(kandelo_fork_instrument_result* result);

#ifdef __cplusplus
}
#endif
#endif
