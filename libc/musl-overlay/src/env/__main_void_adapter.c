/*
 * Weak __main_void adapter for a non-standard `void main()`.
 *
 * A `void main()` (no `int` return) is common in beginner code and works on
 * native targets, but on wasm clang refuses to emit the __main_void /
 * __main_argc_argv adapter for it (it only warns). Kandelo's crt1 always
 * calls __main_argc_argv, whose weak forwarder (__main_void.c) lands on
 * __main_void; for a void main that symbol is otherwise undefined, so the
 * program traps on its first call to main. This weak __main_void adapts such
 * a main: call it and report success.
 *
 * CRITICAL: this adapter — and its `void`-typed reference to `main` — lives
 * in its OWN translation unit / archive member, separate from the
 * __main_argc_argv forwarder that crt1 pulls into every link. The linker
 * pulls this member ONLY when __main_void is an undefined reference, i.e.
 * exactly the `void main()` case:
 *   - int main(int,char**): clang emits a strong __main_argc_argv; crt's
 *     reference is satisfied without pulling the forwarder, __main_void is
 *     never referenced, and this member is not pulled.
 *   - int main(void): clang emits a strong __main_void; this member's weak
 *     __main_void is not needed, so the member is not pulled.
 *   - void main(): neither symbol exists; the forwarder pulls __main_void,
 *     which is undefined, so this member is pulled and its `main` reference
 *     (() -> void) matches the program's actual void main.
 * Keeping it isolated means int-main programs never carry a conflicting
 * `main` type reference (which would otherwise surface as a wasm-ld
 * "defined as () -> void" signature-mismatch across the whole tree).
 */
__attribute__((__weak__))
int __main_void(void) {
    extern void main(void);
    main();
    return 0;
}
