/* When a program defines main(void), clang emits __main_void.
 * This weak wrapper satisfies the __main_argc_argv reference from crt1.o
 * by forwarding to __main_void, discarding argc/argv.
 *
 * Programs that define main(int, char**) provide a strong __main_argc_argv
 * symbol, so this weak definition is ignored in that case. */
int __main_void(void);
__attribute__((__weak__))
int __main_argc_argv(int argc, char **argv) {
    (void)argc;
    (void)argv;
    return __main_void();
}

/* A non-standard `void main()` (no `int` return) is common in beginner code
 * and works on native targets. On wasm, clang refuses to emit the
 * __main_void / __main_argc_argv adapter for it (only warns), so the
 * forwarder above would otherwise land on an undefined __main_void and the
 * program would trap on its first call to main. This weak __main_void adapts
 * such a main: call it and report success. A conforming `int main(void)`
 * makes clang emit a STRONG __main_void that overrides this weak one, so the
 * void-typed `main` reference below is discarded and never conflicts with the
 * program's int-returning main. */
__attribute__((__weak__))
int __main_void(void) {
    extern void main(void);
    main();
    return 0;
}
