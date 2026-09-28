/*
 * Opt-in ucontext stand-ins: sysroot/lib/libkandelo-ucontext-unsupported.a
 *
 * Kandelo does not implement getcontext/setcontext/makecontext/swapcontext
 * (docs/posix-status.md): switching stacks needs a way to save and resume a
 * WebAssembly call stack, which today's Wasm runtimes do not provide. libc.a
 * therefore defines none of them, and by default a program that calls them
 * fails to link. That link failure is the platform boundary.
 *
 * Some software references ucontext without depending on it. PHP 8.3 is the
 * motivating case: Zend always compiles Fibers, and without Fiber assembly
 * for the target it needs <ucontext.h>, but PHP code that never starts a
 * Fiber never calls these functions. A package in that position can link
 * this library to accept the boundary explicitly:
 *
 *     LIBS="-lkandelo-ucontext-unsupported"
 *
 * Each function writes a diagnostic to stderr and aborts, so a program that
 * does reach ucontext stops with SIGABRT at the unsupported call instead of
 * running on. Returning -1/ENOSYS was rejected: PHP ignores the return values
 * of getcontext() and swapcontext(), so an error return would let a Fiber
 * "start" on an uninitialized context and misbehave silently. WordPress
 * Playground makes the same choice for its PHP builds.
 *
 * This library is not linked by default and must stay that way: linking it
 * implicitly would turn a visible link-time gap into a runtime abort for
 * every program, including ones that would have fallen back to another
 * implementation had the link failed.
 */

#include <stdlib.h>
#include <string.h>
#include <ucontext.h>
#include <unistd.h>

static _Noreturn void ucontext_unsupported(const char *name)
{
    static const char suffix[] =
        ": ucontext is not supported on Kandelo "
        "(this program linked -lkandelo-ucontext-unsupported)\n";
    (void)!write(STDERR_FILENO, name, strlen(name));
    (void)!write(STDERR_FILENO, suffix, sizeof suffix - 1);
    abort();
}

int getcontext(ucontext_t *ucp)
{
    (void)ucp;
    ucontext_unsupported("getcontext");
}

int setcontext(const ucontext_t *ucp)
{
    (void)ucp;
    ucontext_unsupported("setcontext");
}

void makecontext(ucontext_t *ucp, void (*func)(void), int argc, ...)
{
    (void)ucp;
    (void)func;
    (void)argc;
    ucontext_unsupported("makecontext");
}

int swapcontext(ucontext_t *restrict oucp, const ucontext_t *restrict ucp)
{
    (void)oucp;
    (void)ucp;
    ucontext_unsupported("swapcontext");
}
