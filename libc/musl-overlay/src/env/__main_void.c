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
