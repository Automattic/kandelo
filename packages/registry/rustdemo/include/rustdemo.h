/* rustdemo — C API for the rustdemo Rust library (Kandelo reference). */
#ifndef RUSTDEMO_H
#define RUSTDEMO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* CRC-32 (IEEE 802.3) over `len` bytes at `data`. */
uint32_t rustdemo_crc32(const unsigned char *data, size_t len);

/* NUL-terminated version string owned by the library. */
const char *rustdemo_version(void);

#ifdef __cplusplus
}
#endif

#endif /* RUSTDEMO_H */
