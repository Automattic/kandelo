# wasm-local-root-spill

`wasm-local-root-spill` is a narrow post-link rewrite pass for conservative
guest garbage collectors. Its first supported profile is `ruby`, where CRuby
expects live `VALUE` roots to be discoverable by scanning stack memory.

WebAssembly does not expose optimized locals or operand-stack values as bytes
in linear memory. That is normally fine for code with explicit root maps, but
it is a problem for runtimes that still use conservative stack scans. A Ruby
object pointer can be live only in a Wasm `i32` local across a call that may
allocate and trigger GC. CRuby's scan cannot see that local, so the object can
be treated as unreachable even though the Wasm program is still using it.

This tool makes those roots visible by adding a small linear-stack spill frame
to call-bearing functions:

- reserve a frame by adjusting the module's mutable `__stack_pointer`;
- seed slots for `i32` parameters and selected locals;
- mirror later `local.set` and `local.tee` writes into those slots;
- materialize `i32` operand-stack carryovers before calls and structured
  regions that contain calls;
- restore `__stack_pointer` on fallthrough, `return`, branch-to-exit, and
  uncaught throw exits.

The pass is intentionally separate from `wasm-fork-instrument`. Packages that
need both run local-root spill first, then fork instrumentation. Root spilling
preserves ordinary execution semantics; fork instrumentation adds save/restore
machinery for POSIX `fork()`.

## Why Ruby 4 needs it

The Ruby 4 Homebrew package path exercises GC-sensitive code during startup,
static extension initialization, and stdlib loads such as `date`, `psych`,
`uri`, and `rubygems`. In the Kandelo wasm32 build, Ruby's `VALUE` is represented
as a 32-bit value, and optimized Wasm locals can hold live `VALUE`s that the
conservative CRuby stack scanner cannot see.

The failure mode was not hypothetical. The normal package artifact without this
pass failed the Homebrew-facing probes with out-of-bounds traps, type errors, or
hangs in:

- `ruby -rdate`
- `ruby -rpsych` with `Psych.dump` / `Psych.load`
- `ruby -ruri`
- `ruby -rrubygems`
- Homebrew's `ruby_check_version_script.rb`

After the Ruby package build applies this pass, then applies
`wasm-fork-instrument`, the same package-level Node and browser probes are
expected to keep the Ruby stdlib roots visible to CRuby's GC.

Ruby 4 is the immediate target because the upstream Homebrew bootstrap needs
Ruby 4 and because Ruby 4's parser, compiler, RubyGems, Psych, URI, encoding,
and static-extension paths allocate through enough nested calls to expose the
missing-root problem. Older or smaller Ruby smoke tests can miss the same class
of bug simply because they do not trigger collection at the vulnerable point.

## Applicability to other runtimes

This approach may be useful for another runtime only if all of these are true:

- the runtime uses a conservative scan of linear stack memory for roots;
- guest heap references are represented as scalar Wasm values, currently
  32-bit `i32` values in wasm32;
- the runtime can tolerate conservative false positives, meaning spilled values
  that look like object references may retain objects longer;
- the package already has tests that can prove the transformed binary still
  behaves correctly in both Node and browser hosts.

Likely candidates are other C/C++ language runtimes or embedders that use a
conservative GC and store tagged heap references as wasm32 integers. The tool
is not a general root-map generator. It is not useful as-is for runtimes with
precise compiler-generated root maps, reference-counted runtimes such as
QuickJS, or runtimes that store live references in Wasm GC/reference-typed
values instead of linear-memory pointers.

New runtimes should get their own profile, root-width model, fixtures, and
package probes. Do not silently reuse the `ruby` profile just because a binary
contains `i32` locals.

## Risk profile

The pass is conservative by design. It prefers a failed build over a partial
root set when it cannot analyze an operand-stack carryover safely.

Main risks:

- **Runtime overhead.** Call-bearing functions gain stack adjustment, memory
  stores for mirrored roots, and exit-path stack restoration.
- **Stack pressure.** Each instrumented function reserves extra linear stack
  bytes. Ruby currently pairs this with a larger explicit wasm stack.
- **Conservative retention.** Mirrored `i32` values can keep objects alive
  longer if they look like Ruby `VALUE`s after their logical lifetime.
- **Stack-pointer correctness.** Any missed exit path would leak stack space.
  The implementation rewrites fallthrough, explicit returns, branch-to-exit,
  and uncaught throws, and tests cover these shapes.
- **Unsupported Wasm features.** Unknown stack effects, ref-typed carryovers,
  memory64, and non-`i32` root widths fail or stay out of scope rather than
  producing silent partial coverage.

This is a package-build compatibility pass, not a kernel ABI. It does not add
host imports, exports, syscalls, or VFS behavior, and it should not make Node
and browser hosts diverge.

## Known gaps

These are deliberate limits of the first Ruby-focused implementation:

- only the `ruby` profile is accepted;
- only wasm32 modules with a mutable `i32` `__stack_pointer` are supported;
- only 32-bit `VALUE`-like roots are spilled;
- `i64`, `f32`, `f64`, `v128`, and reference-typed values are not root slots;
- memory64 and runtimes that depend on Wasm GC refs are unsupported;
- the first memory is used for spill slots; multi-memory support is not modeled;
- the transform instruments call-bearing functions and does not spill leaf
  functions that cannot allocate through a call;
- liveness is intentionally coarse. The default `all-i32` mode spills more
  locals than a precise analysis would;
- the unit tests use focused WAT fixtures. Package-level Ruby probes remain the
  evidence that this is sufficient for the Ruby artifact.

The largest implementation holes to fill before broadening this tool are:

1. Add real-runtime fixture tests for each new profile, not only synthetic WAT.
2. Model non-`i32` root representations when a runtime actually needs them.
3. Add multi-memory and memory64 support only with a concrete consumer.
4. Measure package startup/runtime overhead if the pass moves from Ruby-specific
   compatibility into broader package policy.
5. Keep fail-loud diagnostics clear enough that an unsupported binary cannot be
   mistaken for a successfully protected one.
