#include <stdio.h>
#include <string.h>
#include <zlib.h>

int main(void) {
    const char *original = "Hello from zlib in WebAssembly!";
    uLong orig_len = (uLong)strlen(original) + 1;

    uLong comp_len = compressBound(orig_len);
    unsigned char compressed[256];
    unsigned char decompressed[256];

    int rc = compress(compressed, &comp_len, (const unsigned char *)original, orig_len);
    if (rc != Z_OK) {
        printf("FAIL: compress returned %d\n", rc);
        return 1;
    }
    printf("OK: compressed %lu -> %lu bytes\n", orig_len, comp_len);

    uLong decomp_len = sizeof(decompressed);
    rc = uncompress(decompressed, &decomp_len, compressed, comp_len);
    if (rc != Z_OK) {
        printf("FAIL: uncompress returned %d\n", rc);
        return 1;
    }

    if (strcmp((char *)decompressed, original) != 0) {
        printf("FAIL: roundtrip mismatch\n");
        return 1;
    }

    printf("OK: roundtrip matches\n");
    printf("PASS\n");
    return 0;
}
