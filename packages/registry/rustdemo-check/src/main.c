/* rustdemo-check — a C program that depends on the rustdemo Rust library
 * package and calls its C API. Proves a Rust library is consumable through
 * the normal package resolver path (dependency flags, header, static lib). */
#include <stdio.h>
#include <string.h>
#include "rustdemo.h"

int main(void) {
    const char *s = "123456789";
    unsigned int crc = rustdemo_crc32((const unsigned char *)s, strlen(s));
    printf("rustdemo_version() = %s\n", rustdemo_version());
    printf("rustdemo_crc32(\"123456789\") = 0x%08X\n", crc);
    /* 0xCBF43926 is the canonical CRC-32 check value for "123456789". */
    if (crc != 0xCBF43926u) {
        fprintf(stderr, "FAIL: unexpected CRC\n");
        return 1;
    }
    printf("rustdemo (Rust library package) consumed from C OK\n");
    return 0;
}
