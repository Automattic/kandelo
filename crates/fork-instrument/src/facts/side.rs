//! Compiler-fact format and checked callback registry contracts.

/// The only facts format this analysis models.
pub const FORMAT_VERSION: &str = "5";

/// Registration APIs: (demangled wasm name, mangled symbol, callback arg, registry).
pub(crate) const REG_APIS: &[(&str, &str, u32, &str)] = &[
    ("pthread_key_create", "pthread_key_create", 1, "tsd"),
    ("__pthread_key_create", "__pthread_key_create", 1, "tsd"),
    ("atexit", "atexit", 0, "exit"),
    ("__cxa_atexit", "__cxa_atexit", 0, "exit"),
    ("at_quick_exit", "at_quick_exit", 0, "exit"),
    ("__cxa_thread_atexit", "__cxa_thread_atexit", 0, "exit"),
    (
        "__cxa_thread_atexit_impl",
        "__cxa_thread_atexit_impl",
        0,
        "exit",
    ),
    ("pthread_once", "pthread_once", 1, "once"),
    ("__pthread_once", "__pthread_once", 1, "once"),
    ("call_once", "call_once", 1, "once"),
    ("pthread_create", "pthread_create", 2, "thread"),
    ("__pthread_create", "__pthread_create", 2, "thread"),
    ("thrd_create", "thrd_create", 1, "thread"),
    ("qsort", "qsort", 3, "cmp"),
    ("qsort_r", "qsort_r", 3, "cmp"),
    ("__qsort_r", "__qsort_r", 3, "cmp"),
    ("bsearch", "bsearch", 4, "cmp"),
    (
        "_pthread_cleanup_push",
        "_pthread_cleanup_push",
        1,
        "cleanup",
    ),
    ("pthread_atfork", "pthread_atfork", 0, "atfork"),
    ("signal", "signal", 1, "signal"),
    ("bsd_signal", "bsd_signal", 1, "signal"),
    ("sigset", "sigset", 1, "signal"),
    (
        "std::set_terminate(void (*)())",
        "_ZSt13set_terminatePFvvE",
        0,
        "terminate",
    ),
    (
        "std::set_unexpected(void (*)())",
        "_ZSt14set_unexpectedPFvvE",
        0,
        "unexpected",
    ),
    (
        "std::set_new_handler(void (*)())",
        "_ZSt15set_new_handlerPFvvE",
        0,
        "new_handler",
    ),
    ("__synccall", "__synccall", 0, "synccall"),
];

/// Registry dispatch sites, bound to the defining source file (module id
/// suffix) so an unrelated function with the same name is never treated as a
/// hub. Each entry was checked against the musl / libc++abi source.
/// (module suffix, function, callback type id, registries)
pub(crate) const HUBS: &[(&str, &str, &str, &[&str])] = &[
    // pthread_exit runs cleanup handlers and (inlined) TSD destructors.
    (
        "thread/pthread_create.c",
        "__pthread_exit",
        "_ZTSFvPvE",
        &["tsd", "cleanup"],
    ),
    (
        "thread/pthread_key_create.c",
        "__pthread_tsd_run_dtors",
        "_ZTSFvPvE",
        &["tsd"],
    ),
    (
        "thread/pthread_cleanup_push.c",
        "_pthread_cleanup_pop",
        "_ZTSFvPvE",
        &["cleanup"],
    ),
    // __cxa_atexit(func, arg) handlers; atexit(f) registers `call` with f.
    ("exit/atexit.c", "__funcs_on_exit", "_ZTSFvPvE", &["exit"]),
    ("exit/atexit.c", "call", "_ZTSFvvE", &["exit"]),
    (
        "exit/at_quick_exit.c",
        "__funcs_on_quick_exit",
        "_ZTSFvvE",
        &["exit"],
    ),
    (
        "cxa_thread_atexit.cpp",
        "__cxxabiv1::(anonymous namespace)::run_dtors(void*)",
        "_ZTSFvPvE",
        &["exit"],
    ),
    (
        "thread/pthread_once.c",
        "__pthread_once_full",
        "_ZTSFvvE",
        &["once"],
    ),
    (
        "thread/pthread_create.c",
        "start",
        "_ZTSFPvS_E",
        &["thread"],
    ),
    (
        "thread/pthread_create.c",
        "start_c11",
        "_ZTSFiPvE",
        &["thread"],
    ),
    (
        "stdlib/qsort_nr.c",
        "wrapper_cmp",
        "_ZTSFiPKvS0_E",
        &["cmp"],
    ),
    ("stdlib/qsort.c", "sift_down", "_ZTSFiPKvS0_PvE", &["cmp"]),
    ("stdlib/bsearch.c", "bsearch", "_ZTSFiPKvS0_E", &["cmp"]),
    (
        "thread/pthread_atfork.c",
        "__fork_handler",
        "_ZTSFvvE",
        &["atfork"],
    ),
    (
        "cxa_handlers.cpp",
        "std::__terminate(void (*)())",
        "_ZTSFvvE",
        &["terminate"],
    ),
    (
        "cxa_handlers.cpp",
        "std::__unexpected(void (*)())",
        "_ZTSFvvE",
        &["unexpected"],
    ),
    (
        "new.cpp",
        "operator new(unsigned long)",
        "_ZTSFvvE",
        &["new_handler"],
    ),
    (
        "new.cpp",
        "operator new(unsigned long, std::align_val_t)",
        "_ZTSFvvE",
        &["new_handler"],
    ),
    // Kandelo signal delivery (inlined into __do_syscall_impl): handlers come
    // from sigaction/signal registrations through the kernel.
    ("glue/channel_syscall.c", "*", "_ZTSFviE", &["signal"]),
    (
        "glue/channel_syscall.c",
        "*",
        "_ZTSFviP9siginfo_tPvE",
        &["signal"],
    ),
    // musl __synccall(func, ctx): func runs in every thread's SIGSYNCCALL handler.
    ("thread/synccall.c", "handler", "_ZTSFvPvE", &["synccall"]),
    (
        "thread/synccall.c",
        "__synccall",
        "_ZTSFvPvE",
        &["synccall"],
    ),
];
