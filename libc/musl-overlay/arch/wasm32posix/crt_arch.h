/* Wasm has no architecture-specific stack setup. The common Kandelo crt1.c
 * owns the exported _start and its capacity-bearing argv/environment setup. */
#define START "_start"
