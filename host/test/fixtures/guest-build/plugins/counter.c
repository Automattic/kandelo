/* An ordinary installed library: Libtool builds it static only. */
int counter_next(void) {
    static int n;
    return ++n;
}
