/*
 * ssl_basic.c — Minimal test that OpenSSL links and works.
 * Calls SSL_CTX_new / SSL_CTX_free to verify the library is functional.
 */
#include <stdio.h>
#include <openssl/ssl.h>
#include <openssl/err.h>

int main(void)
{
    /* Initialize OpenSSL */
    OPENSSL_init_ssl(0, NULL);

    /* Create an SSL context */
    const SSL_METHOD *method = TLS_client_method();
    SSL_CTX *ctx = SSL_CTX_new(method);
    if (!ctx) {
        printf("FAIL: SSL_CTX_new returned NULL\n");
        ERR_print_errors_fp(stdout);
        return 1;
    }

    printf("OK: SSL_CTX_new succeeded\n");
    printf("OpenSSL version: %s\n", OpenSSL_version(OPENSSL_VERSION));

    SSL_CTX_free(ctx);
    printf("OK: SSL_CTX_free succeeded\n");
    printf("PASS\n");
    return 0;
}
