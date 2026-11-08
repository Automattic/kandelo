_Thread_local int tls_base = 7;

int tls_weighted(int value) {
    return value + tls_base++;
}
