/* Concurrent OpenSSL decoding from several pthreads: the pattern a
 * multi-threaded TLS client performs while loading keys and certificates. */
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/x509.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

#define THREADS 8
#define ITERATIONS 400

static unsigned char *der;
static int der_len;
static pthread_barrier_t start;

static void *worker(void *arg) {
    (void)arg;
    pthread_barrier_wait(&start);
    for (int i = 0; i < ITERATIONS; i++) {
        const unsigned char *p = der;
        /* A fresh library context per call makes every decode populate the
         * shared property-string store, as first use on each thread does. */
        OSSL_LIB_CTX *ctx = (i & 1) ? OSSL_LIB_CTX_new() : NULL;
        EVP_PKEY *key = d2i_PUBKEY_ex(NULL, &p, der_len, ctx, NULL);
        if (!key) {
            ERR_print_errors_fp(stderr);
            fprintf(stderr, "decode failed\n");
            exit(2);
        }
        EVP_PKEY_free(key);
        OSSL_LIB_CTX_free(ctx);
    }
    return NULL;
}

int main(void) {
    EVP_PKEY *key = EVP_PKEY_Q_keygen(NULL, NULL, "EC", "P-256");
    if (!key) { ERR_print_errors_fp(stderr); return 1; }
    der_len = i2d_PUBKEY(key, &der);
    EVP_PKEY_free(key);
    if (der_len <= 0) return 1;
    pthread_t threads[THREADS];
    pthread_barrier_init(&start, NULL, THREADS);
    for (int i = 0; i < THREADS; i++)
        if (pthread_create(&threads[i], NULL, worker, NULL) != 0) return 1;
    for (int i = 0; i < THREADS; i++) pthread_join(threads[i], NULL);
    printf("OPENSSL_THREADS_OK %d threads x %d decodes\n", THREADS, ITERATIONS);
    return 0;
}
