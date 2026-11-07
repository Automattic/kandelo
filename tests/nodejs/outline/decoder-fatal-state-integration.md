# Decoder fatal recovery and completed state retirement

The real shared decoder now preserves successful BOM state on streaming fatal
errors, discards failed-call pending/output state, and captures rollback only
after the stream getter can reenter the receiver. Successful nonstream calls
construct current output before immediately retiring pending/BOM state. Fatal
nonstream calls also retire state. No fresh-stream facade or forced stream=false
hides conversion errors.

Independent review found stale snapshot reentry regressions in the original
proposal. A separate snapshot correction passed8cases, but a stricter ninth
single-inner-flush case still failed. That newly exposed regression was not
excused as preexisting: a second additive correction owns actual nonstream
retirement. All original/intermediate source/results/seals and strict failure
remain. Input/options entry chronology and full encoding repertoire stay open.

Final root controls match29logical groups (20fatal+9reentry) in both slow-state
and optional validated-UTF8 component modes. Four unchanged focused upstream
files pass native/slow/fast:12subjects,0skips. Native VM/isUtf8/fast conversion
are explicit fixture dependencies, not guest native-byte/GC/lifecycle proof.
No assertion is changed or unsupported API counted as passing compatibility.
Normal885inputs/core/bootstrap/staging and14package checks pass.

Decoder code has0compiler invocations. Separately, the supported cacheGC command
performed1native Cargo production build of xtask/runtime-core; actual artifacts
and706repository inputs are retained. GC skipped a held cache lock and removed
0entries. No full product/engine build, current kernel link or overall suite ran.
A metadata recorder initially assumed flat old artifact paths; exact prior
preservedCopy corrected that packaging guard without rerunning compilation.

Full repertoire/options/input/prototypes/brands/inspection/error details,
shared/detached/growable/concurrent bytes, GC/OOM, TextDecoderStream/Fetch and
identified-artifact four-host conformance remain open. No finding/family closes.
Pins/audit/unrelated work and separate Claude/npm/Bun remainder are preserved.
Nested guest Wasm remains in scope for the final phase.
