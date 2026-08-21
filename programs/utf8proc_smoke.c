/*
 * utf8proc_smoke — PR19 proof that the wasm32 utf8proc port
 * (packages/registry/utf8proc) normalizes, case-maps, and segments
 * against the kernel's libc, with nothing mocked.
 *
 * fcft leans on utf8proc for grapheme segmentation and foot for
 * case-insensitive search — the three checks below cover those calls.
 *
 *   [NFC]      e + combining acute normalizes to the precomposed é.
 *   [LOWER]    utf8proc_tolower maps É -> é.
 *   [GRAPHEME] a|b is a grapheme break; a regional-indicator pair is not.
 *
 * Prints one line per checkpoint and "UTF8PROC_SMOKE_OK" on success;
 * exits non-zero on any failure. host/test/utf8proc-smoke.test.ts
 * asserts the markers.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <utf8proc.h>

int main(void) {
    printf("[VERSION] %s\n", utf8proc_version());

    utf8proc_uint8_t *nfc =
        utf8proc_NFC((const utf8proc_uint8_t *)"e\xCC\x81");
    if (!nfc) { fprintf(stderr, "NFC failed\n"); return 1; }
    printf("[NFC] len=%zu\n", strlen((const char *)nfc));
    if (strcmp((const char *)nfc, "\xC3\xA9") != 0) return 1;
    free(nfc);

    utf8proc_int32_t lower = utf8proc_tolower(0x00C9);
    printf("[LOWER] 0x%04x\n", (unsigned)lower);
    if (lower != 0x00E9) return 1;

    utf8proc_int32_t state = 0;
    if (!utf8proc_grapheme_break_stateful('a', 'b', &state)) return 1;
    state = 0;
    if (utf8proc_grapheme_break_stateful(0x1F1EF, 0x1F1F5, &state)) return 1;
    printf("[GRAPHEME] ok\n");

    printf("UTF8PROC_SMOKE_OK\n");
    return 0;
}
