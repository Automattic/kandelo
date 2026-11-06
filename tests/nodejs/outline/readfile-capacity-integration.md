# ReadFile actual allocation capacity integration

Source152 integrates the reviewed ReadFile native allocation producer. Actual
successful malloc/realloc capacity remains separate from the logical result
length through native work, result preparation and the existing USER_OWNED
backing transaction. Failed growth preserves the prior allocation; failed
optional shrink preserves its capacity while reading still succeeds. Empty
results retain their real one-byte allocation. Actual owner/span claims keep
that storage alive until its allocator deallocates it, including native-thread
last release. WriteFile and recursive-copy algorithms are preserved.

The producer implements the existing backing capability interface. It adds no
engine API, kernel/host ABI change or public metadata facade. Its new header
is declared and staged through the normal package path. Source151's separate
VM/backing compilation corrections remain present.

The source matches the sealed proposal's complete postimages. Current-source
bundle/input and normal header/unity staging checks pass with716 guarded files;
all14 existing package-source tests pass without skips. The first root staging
check incorrectly expected an unrewritten private include; its failure remains
recorded. The corrected fixture expects the normal generator's exact shell
include rewrite. Production generator behavior and assertions were unchanged.

Previously identified evidence is reused, not counted as fresh execution:
actual owner/exact-worker controls for capacity, growth/shrink/faults/errors,
fd cleanup, aliases, account retirement and native-thread last release; five
pinned native Node result/error/fd cases; and the historical failing before
control. Their exact source, binaries, compiler and nonpasses remain sealed.
The shared ledger and public capability headers still match those controls.

Production JSAPI compilation, allocation/conversion failure callback parity,
GC/realm/transfer/clone behavior, public memory-metric categories and current
four-host conformance remain open. The actual source150 build failed; source152
has not been compiled into an accepted engine. Overall suites and the full
product rebuild remain deferred. No filesystem finding or family is closed.

Exact evidence: [readfile-capacity-finding-progress.json](readfile-capacity-finding-progress.json).
