# Public process abort owns real signal death

Source218 replaces the numeric std.exit(134) facade with the actual named native
abort function. The actual JSAPI entry prints real executing engine frames and
calls shared process-state std::abort. It bypasses ordinary exit listeners and
orderly teardown; libc and existing kernel exact-task signal/wait owners retain
their responsibilities. A Wasm trap fallback is not credited as SIGABRT.

Workers consume the unchanged pinned unavailable factory after values/error
initialization, with disabled property and ignored receiver/arguments. A native
context Worker guard independently refuses private entry. This source avoids
public metadata as ownership authority. Independent source review traces the
actual signature/header/frame dump/init/Worker/musl path without guest execution.
Its only correction removes trailing spaces in the pinned factory; tokens and
original producer/review seals remain unchanged.

Four native actual-header cases cover default/ignored/returning-handler/blocked
SIGABRT with native libc. Three frontend groups consume actual native Node abort
and errors, not the new guest entry. Root freshly matches shape/Worker groups;
header4 and fatal1 are reused after exact source/evidence checks. These do not
validate guest musl/kernel/host/parent wait, JSAPI or native diagnostics.

Both tiny helper compiler invocations succeeded. First helper run exit31 came
from inherited unflushed stdout and remains with original source/artifact;
corrected control flushes before fork. Two invalid syntax harness assemblies
and original failed source predicate remain preserved. Normal root core/bootstrap
generation,885inputs,unchanged style checker and14package checks now pass. There
is no new root compile, overall suite or full product rebuild.

Actual new guest binding compilation/execution, exact abort diagnostics/native
stack/core dump/report, separate default uncaught SIGTRAP-versus-SIGABRT and
fatal/rejection/beforeExit/signal/Worker/realm/GC/four-host obligations remain
incomplete. No audit finding/family closes.217Blob and215/216VM/capture source,
target pins and unrelated work are preserved. Nested Wasm remains in scope last.
