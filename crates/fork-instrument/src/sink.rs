//! Shared sink policy and bounded compiler-facts projection.

/// How signal-handler dispatch inside libc's syscall path is modelled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignalPolicy {
    /// Handlers are ordinary indirect calls (every table function of the
    /// handler signature). Sound with no POSIX gap.
    Strict,
    /// A run-time gate aborts a fork from inside a handler whose child would
    /// return into the interrupted code; handler dispatch stops the closure.
    Gate,
}

#[derive(Clone, Copy, Debug)]
pub struct SinkPolicy {
    pub signal: SignalPolicy,
}

impl Default for SinkPolicy {
    fn default() -> Self {
        SinkPolicy {
            signal: SignalPolicy::Strict,
        }
    }
}

/// Indirect-call facts derived from compiler facts (see [`crate::facts`]).
#[derive(Debug, Default, Clone)]
pub struct CallFacts {
    /// Per (function index, Wasm signature of a `call_indirect` in it): the
    /// functions those sites can call. The signature is written
    /// `params->results` with `i32`/`i64`/`f32`/`f64`/`v128`, and `ref` for
    /// every reference type.
    pub itargets: Vec<(u32, String, Vec<u32>)>,
    /// Per caller of `_pthread_cleanup_pop` (by name): the handlers its own
    /// lexical `pthread_cleanup_push` installs.
    pub cleanup: Vec<(String, Vec<String>)>,
    /// setjmp/longjmp buffer identity, the plugin's `JS`/`JL` lines verbatim
    /// (`JS\t<function>\t<buffer>`; buffer `*` is unknown).
    pub jmp: Vec<String>,
    /// Research only: assume the load-time dlopen contract
    /// (`docs/plans/2026-10-02-fork-sinks.md`, "Fork sinks in programs that
    /// can dlopen") and ignore side-module entries. Unsound until the host
    /// enforces that contract; the instrumenter never sets it.
    pub assume_dlopen_contract: bool,
}
