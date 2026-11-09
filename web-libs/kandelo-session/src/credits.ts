// Credits for the open source projects that have helped Kandelo.
//
// One list feeds both the docs site's Credits page
// (docs-site/reference/credits.md) and the browser app's Credits dialog, so
// the two cannot drift apart. Licenses for third-party code kept in the
// repository are tracked in LICENSE, not here.
//
// Array order is display order, with the projects that mattered most to
// Kandelo first in each section.

export interface CreditEntry {
  name: string;
  url: string;
  /** The people or project behind it. Omitted when the name says it. */
  by?: string;
  /** What it is and what Kandelo uses it for, in plain words. */
  use: string;
}

export interface CreditSection {
  title: string;
  intro?: string;
  entries: CreditEntry[];
}

/** The organization that develops Kandelo, named in the opening sentence of
 *  the credits. */
export const CREDITS_DEVELOPER = {
  name: "Automattic",
  url: "https://automattic.com/",
} as const;

export const CREDITS: readonly CreditSection[] = [
  {
    title: "POSIX and C library test suites",
    intro:
      "These suites shaped Kandelo's kernel and libc more than anything else.",
    entries: [
      {
        name: "os-test",
        url: "https://sortix.org/os-test/",
        by: "Jonas 'Sortie' Termansen and the Sortix contributors",
        use: "Tests POSIX interfaces across operating systems. Kandelo runs it as "
          + "its main POSIX conformance suite.",
      },
      {
        name: "libc-test",
        url: "https://wiki.musl-libc.org/libc-test",
        by: "Szabolcs Nagy and the musl project",
        use: "Unit and regression tests for a C and POSIX library. Kandelo runs "
          + "the full suite against its musl build.",
      },
      {
        name: "Open POSIX Test Suite",
        url: "https://github.com/linux-test-project/ltp",
        by: "Its original authors at Intel, now maintained in the Linux Test Project",
        use: "Kandelo runs its conformance tests for signals, scheduling, memory, "
          + "string, and time interfaces.",
      },
    ],
  },
  {
    title: "Compilers, libraries, and tools",
    entries: [
      {
        name: "musl libc",
        url: "https://musl.libc.org/",
        by: "Rich Felker and contributors",
        use: "Kandelo's C library. Kandelo adds an overlay and syscall glue for "
          + "its WebAssembly target.",
      },
      {
        name: "LLVM",
        url: "https://llvm.org/",
        use: "Clang, wasm-ld, and libc++ compile and link the programs that run "
          + "on Kandelo.",
      },
      {
        name: "Rust",
        url: "https://www.rust-lang.org/",
        use: "The kernel, the fork instrumenter, and the build tools are written "
          + "in Rust.",
      },
      {
        name: "Asyncify",
        url: "https://kripken.github.io/blog/wasm/2019/07/16/asyncify.html",
        by: "Alon Zakai, in Binaryen",
        use: "Kandelo's fork() was first built on Asyncify. The fork instrumenter "
          + "that replaced it uses the same idea: save the call stack in the "
          + "parent and rebuild it in the child.",
      },
      {
        name: "wasm-tools",
        url: "https://github.com/bytecodealliance/wasm-tools",
        by: "The Bytecode Alliance",
        use: "Its parser and encoder crates read and rewrite WebAssembly modules "
          + "for fork instrumentation and ABI checks.",
      },
      {
        name: "Binaryen",
        url: "https://github.com/WebAssembly/binaryen",
        use: "wasm-opt optimizes Kandelo programs after linking.",
      },
      {
        name: "wasi-libc",
        url: "https://github.com/WebAssembly/wasi-libc",
        use: "Its setjmp and longjmp support showed the way for Kandelo's own.",
      },
    ],
  },
  {
    title: "Inspiration",
    entries: [
      {
        name: "WordPress Playground",
        url: "https://github.com/WordPress/wordpress-playground",
        use: "Showed PHP and WordPress running in the browser before Kandelo did. "
          + "Kandelo relies on its TLS 1.2 support and its CORS proxy.",
      },
    ],
  },
];
