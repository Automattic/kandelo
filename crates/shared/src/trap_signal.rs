//! Which Wasm trap becomes which POSIX signal, and what a signalled exit
//! status is.
//!
//! This is the platform's answer to "the guest faulted — what does `wait(2)`
//! report?", and it belongs here rather than in one host because every host
//! needs it and they must agree. Before this module the mapping existed only
//! in `host/src/trap-signals.ts`, so a guest divide-by-zero raised `SIGFPE` on
//! Node and in the browser and **nothing at all** under `crates/host-native`.
//!
//! Two layers, deliberately separated:
//!
//! * [`WasmTrapKind`] → signal is the **policy**. A host that learns the trap
//!   kind structurally — wasmtime hands one back as a typed `Trap` — needs only
//!   this half, and no string ever enters the picture.
//! * [`classify_wasm_trap_text`] recovers the kind from an engine's trap
//!   *message*. A JavaScript host has no structured trap: `WebAssembly` throws
//!   a `RuntimeError` whose `message` is engine-defined prose, so recognising
//!   it is unavoidable there. That makes the phrase table a **documented
//!   compatibility boundary** — V8, SpiderMonkey and JavaScriptCore each word
//!   these differently, and new wordings are added here rather than in a host.
//!   It is not a floor: nothing about it requires JavaScript, and keeping one
//!   copy is the point.

/// The kind of fault a Wasm trap represents, at the granularity POSIX signals
/// can express.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmTrapKind {
    /// A linear-memory access outside the accessible range, or an unaligned
    /// access an engine refuses.
    Memory,
    /// A table or indirect-call index outside its bounds.
    Bounds,
    /// Stack exhaustion.
    Stack,
    /// Integer division/remainder by zero, or a division that overflows.
    Arithmetic,
    /// `unreachable`, a null or type-mismatched indirect call, an uninitialised
    /// table element — control flow the module is not permitted to perform.
    IllegalInstruction,
}

impl WasmTrapKind {
    /// The signal a process takes for this fault.
    ///
    /// `Bounds` and `Stack` are `SIGSEGV` rather than `SIGBUS`: on Linux an
    /// out-of-range access and a stack overflow both deliver `SIGSEGV`, and a
    /// Wasm table index has no closer POSIX analogue than an invalid address.
    pub const fn signal(self) -> u32 {
        match self {
            WasmTrapKind::Memory | WasmTrapKind::Bounds | WasmTrapKind::Stack => {
                crate::signal::SIGSEGV
            }
            WasmTrapKind::Arithmetic => crate::signal::SIGFPE,
            WasmTrapKind::IllegalInstruction => crate::signal::SIGILL,
        }
    }

    /// Stable diagnostic name. Kept identical to the strings the TypeScript
    /// hosts have always reported so worker diagnostics do not change wording.
    pub const fn as_str(self) -> &'static str {
        match self {
            WasmTrapKind::Memory => "memory",
            WasmTrapKind::Bounds => "bounds",
            WasmTrapKind::Stack => "stack",
            WasmTrapKind::Arithmetic => "arithmetic",
            WasmTrapKind::IllegalInstruction => "illegal-instruction",
        }
    }
}

/// The wait status a shell reports for a process killed by `signum`.
///
/// `128 + signum` is the shell convention (`$?`), not the `wait(2)` encoding;
/// it is what the host records as a crashed process's exit status.
pub const fn signal_exit_status(signum: u32) -> i32 {
    128i32.wrapping_add(signum as i32)
}

/// A recognised trap, with the phrase that recognised it for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WasmTrapMatch<'a> {
    pub kind: WasmTrapKind,
    pub matched: &'a str,
}

impl WasmTrapMatch<'_> {
    pub const fn signal(&self) -> u32 {
        self.kind.signal()
    }
}

/// One engine-message shape.
enum Phrase {
    /// Every fragment present, in order, anywhere in the text.
    Seq(&'static [&'static str]),
    /// Every fragment present, in order, within a single line, with the last
    /// fragment standing at word boundaries.
    LineSeq(&'static [&'static str]),
    /// One fragment standing at word boundaries.
    Word(&'static str),
}

/// The compatibility boundary, ordered. The first group that matches wins, so
/// the ordering encodes precedence: an arithmetic phrase beats a memory one,
/// and the memory group's "index out of bounds … memory" beats the bounds
/// group's bare "index out of bounds".
const TRAP_PHRASES: &[(WasmTrapKind, &[Phrase])] = &[
    (
        WasmTrapKind::Arithmetic,
        &[
            // V8 and SpiderMonkey both say "divide by zero"; JavaScriptCore
            // says "division by zero". wasmtime's own message is "integer
            // divide by zero", covered by the first.
            Phrase::Seq(&["divide by zero"]),
            Phrase::Seq(&["division by zero"]),
            Phrase::Seq(&["remainder by zero"]),
            Phrase::Seq(&["integer overflow"]),
        ],
    ),
    (
        WasmTrapKind::Memory,
        &[
            Phrase::Seq(&["memory access out of bounds"]),
            Phrase::Seq(&["out of bounds memory access"]),
            Phrase::Seq(&["out-of-bounds memory"]),
            Phrase::Seq(&["index out of bounds", "memory"]),
            Phrase::Seq(&["memory out of bounds"]),
            Phrase::Seq(&["unaligned access"]),
        ],
    ),
    (
        WasmTrapKind::Bounds,
        &[
            Phrase::LineSeq(&["RuntimeError:", "index out of bounds"]),
            Phrase::Seq(&["table index out of bounds"]),
            Phrase::Seq(&["table index is out of bounds"]),
            Phrase::Seq(&["table index outside"]),
            Phrase::Seq(&["table index is outside"]),
            Phrase::Seq(&["out of bounds call_indirect"]),
            Phrase::Seq(&["indirect call", "out of bounds"]),
        ],
    ),
    (
        WasmTrapKind::IllegalInstruction,
        &[
            Phrase::Word("unreachable"),
            Phrase::Seq(&["call_indirect", "null"]),
            Phrase::Seq(&["call_indirect", "type mismatch"]),
            Phrase::Seq(&["call_indirect", "signature", "does not match"]),
            Phrase::Seq(&["indirect call", "null"]),
            Phrase::Seq(&["indirect call", "type mismatch"]),
            Phrase::Seq(&["function signature mismatch"]),
            Phrase::Seq(&["signature mismatch"]),
            Phrase::Seq(&["signature", "does not match"]),
            Phrase::Seq(&["null function"]),
            Phrase::Seq(&["undefined element"]),
            Phrase::Seq(&["uninitialized element"]),
        ],
    ),
    (
        WasmTrapKind::Stack,
        &[
            Phrase::Seq(&["maximum call stack"]),
            Phrase::Seq(&["call stack size exceeded"]),
            Phrase::Seq(&["call stack exhausted"]),
            Phrase::Seq(&["stack overflow"]),
            Phrase::Seq(&["stack exhausted"]),
        ],
    ),
];

/// Classify an engine's trap message.
///
/// Returns `None` for text that is not a trap at all — a `CompileError`, a
/// `LinkError`, an ABI mismatch. That distinction is load-bearing: those are
/// launch failures, and reporting one as a fatal signal would tell a guest's
/// parent that a program ran and faulted when it never started.
pub fn classify_wasm_trap_text(text: &str) -> Option<WasmTrapMatch<'_>> {
    for (kind, phrases) in TRAP_PHRASES {
        for phrase in *phrases {
            if let Some(matched) = phrase.find(text) {
                return Some(WasmTrapMatch {
                    kind: *kind,
                    matched,
                });
            }
        }
    }
    None
}

/// The wait status for an engine trap message, or `None` when the text is not
/// a trap.
pub fn classified_trap_exit_status(text: &str) -> Option<i32> {
    classify_wasm_trap_text(text).map(|m| signal_exit_status(m.signal()))
}

impl Phrase {
    fn find<'a>(&self, text: &'a str) -> Option<&'a str> {
        match self {
            Phrase::Seq(parts) => find_sequence(text, parts, false),
            Phrase::LineSeq(parts) => text
                .split('\n')
                .find_map(|line| find_sequence(line, parts, true)),
            Phrase::Word(word) => find_word(text, word, 0).map(|(s, e)| &text[s..e]),
        }
    }
}

/// Every part present in order. `last_at_word_boundary` mirrors a trailing
/// `\b…\b` on the final fragment.
fn find_sequence<'a>(
    text: &'a str,
    parts: &[&str],
    last_at_word_boundary: bool,
) -> Option<&'a str> {
    let mut start = None;
    let mut cursor = 0usize;
    for (index, part) in parts.iter().enumerate() {
        let is_last = index + 1 == parts.len();
        let (found, end) = if is_last && last_at_word_boundary {
            find_word(text, part, cursor)?
        } else {
            let at = find_ascii_ci(text, part, cursor)?;
            (at, at + part.len())
        };
        if start.is_none() {
            start = Some(found);
        }
        cursor = end;
    }
    Some(&text[start?..cursor])
}

/// Case-insensitive ASCII substring search starting at `from`, returning a
/// byte offset that is always a `char` boundary because every needle here is
/// pure ASCII and a multi-byte UTF-8 sequence never contains an ASCII byte.
fn find_ascii_ci(text: &str, needle: &str, from: usize) -> Option<usize> {
    let hay = text.as_bytes();
    let pat = needle.as_bytes();
    if pat.is_empty() || from > hay.len() || hay.len() - from < pat.len() {
        return None;
    }
    let last = hay.len() - pat.len();
    let mut at = from;
    while at <= last {
        let mut index = 0;
        while index < pat.len() && hay[at + index].eq_ignore_ascii_case(&pat[index]) {
            index += 1;
        }
        if index == pat.len() {
            return Some(at);
        }
        at += 1;
    }
    None
}

/// `\bword\b`: the same search, but rejecting matches whose neighbours are
/// word characters, so "unreachable" does not match "unreachableness".
fn find_word(text: &str, word: &str, from: usize) -> Option<(usize, usize)> {
    let hay = text.as_bytes();
    let mut cursor = from;
    loop {
        let at = find_ascii_ci(text, word, cursor)?;
        let end = at + word.len();
        let before_ok = at == 0 || !is_word_byte(hay[at - 1]);
        let after_ok = end == hay.len() || !is_word_byte(hay[end]);
        if before_ok && after_ok {
            return Some((at, end));
        }
        cursor = at + 1;
    }
}

const fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(text: &str) -> Option<WasmTrapKind> {
        classify_wasm_trap_text(text).map(|m| m.kind)
    }

    #[test]
    fn memory_and_stack_traps_are_sigsegv() {
        for text in [
            "RuntimeError: memory access out of bounds",
            "RuntimeError: Out of bounds memory access",
            "RuntimeError: operation does not support unaligned accesses",
        ] {
            assert_eq!(kind(text), Some(WasmTrapKind::Memory), "{text}");
            assert_eq!(
                classify_wasm_trap_text(text).unwrap().signal(),
                crate::signal::SIGSEGV
            );
        }
        for text in [
            "RangeError: Maximum call stack size exceeded",
            "RuntimeError: call stack exhausted",
        ] {
            assert_eq!(kind(text), Some(WasmTrapKind::Stack), "{text}");
        }
    }

    #[test]
    fn generic_bounds_traps_are_sigsegv() {
        for text in [
            "RuntimeError: index out of bounds",
            "RuntimeError: table index is out of bounds",
            "RuntimeError: Out of bounds call_indirect",
        ] {
            assert_eq!(kind(text), Some(WasmTrapKind::Bounds), "{text}");
        }
    }

    #[test]
    fn arithmetic_traps_are_sigfpe() {
        for text in [
            "RuntimeError: divide by zero",
            "RuntimeError: integer divide by zero",
            "RuntimeError: integer overflow",
            "RuntimeError: remainder by zero",
        ] {
            assert_eq!(kind(text), Some(WasmTrapKind::Arithmetic), "{text}");
            assert_eq!(
                classify_wasm_trap_text(text).unwrap().signal(),
                crate::signal::SIGFPE
            );
        }
    }

    #[test]
    fn illegal_control_flow_traps_are_sigill() {
        for text in [
            "RuntimeError: unreachable",
            "RuntimeError: unreachable executed",
            "RuntimeError: indirect call type mismatch",
            "RuntimeError: null function or function signature mismatch",
            "RuntimeError: call_indirect to a signature that does not match",
            "RuntimeError: call_indirect to a null table entry",
            "wasm trap: uninitialized element",
        ] {
            assert_eq!(kind(text), Some(WasmTrapKind::IllegalInstruction), "{text}");
            assert_eq!(
                classify_wasm_trap_text(text).unwrap().signal(),
                crate::signal::SIGILL
            );
        }
    }

    #[test]
    fn loader_and_abi_errors_are_not_traps() {
        for text in [
            "CompileError: WebAssembly.compile(): expected magic word",
            "LinkError: WebAssembly.instantiate(): Import #0 module=\"env\" error",
            "ABI version mismatch: program=1 kernel=2",
        ] {
            assert_eq!(kind(text), None, "{text}");
            assert_eq!(classified_trap_exit_status(text), None, "{text}");
        }
    }

    #[test]
    fn call_indirect_bounds_stays_separate_from_a_null_indirect_call() {
        assert_eq!(
            kind("RuntimeError: Out of bounds call_indirect"),
            Some(WasmTrapKind::Bounds)
        );
        assert_eq!(
            kind("RuntimeError: call_indirect to a null table entry"),
            Some(WasmTrapKind::IllegalInstruction)
        );
    }

    #[test]
    fn word_boundaries_are_respected() {
        assert_eq!(
            kind("RuntimeError: code was unreachable"),
            Some(WasmTrapKind::IllegalInstruction)
        );
        // A word that merely contains "unreachable" is not the trap.
        assert_eq!(kind("diagnostic: unreachableness reported"), None);
    }

    #[test]
    fn signal_exit_statuses_follow_the_shell_convention() {
        assert_eq!(signal_exit_status(crate::signal::SIGILL), 132);
        assert_eq!(signal_exit_status(crate::signal::SIGFPE), 136);
        assert_eq!(signal_exit_status(crate::signal::SIGSEGV), 139);
        assert_eq!(
            classified_trap_exit_status("RuntimeError: divide by zero"),
            Some(136)
        );
    }

    #[test]
    fn the_matched_phrase_is_reported_for_diagnostics() {
        let m = classify_wasm_trap_text("RuntimeError: divide by zero").unwrap();
        assert_eq!(m.matched, "divide by zero");
    }
}
