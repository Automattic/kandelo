# Empty positioned tmpfs writes

The actual tmpfs write owner previously computed growth and touched timestamps/
content generation even for an empty buffer. An empty write at offset4096 grew
a four-byte or empty file to4096 while returning0. The native POSIX reference
preserved size/mode/timestamps in four controls; the old candidate failed all4.

The owner now validates real handle/offset/inode/mutability/type, then returns0
before quota/growth/timestamp/generation effects. Nonempty/sparse writes and
actual producer paths are unchanged. A regression checks start/EOF/pastEOF,
contents, timestamps, set-ID mode and content generation. The contract permits
error detection; see the approved [POSIX interpretation](https://www.open-std.org/jtc1/sc22/WG15/docs/rr/9945-1/9945-1-07.html).

Current actual native production library passes the same4 standalone control
scenarios.37tmpfs+8opened-dentry cases pass on the current identified native test
artifact. The new regression is included in those45, not counted twice after its
initial individual run. Source/build input and bootstrap/native unity checks
remain coherent with engine214/884inputs; identical package inputs reuse earlier14
checks. No Wasm/kernel instantiation, overall suite or full product rebuild ran.

Four initial standalone compiler/link failures came from missing host dependency
search paths and omitted Cargo release LTO settings. The first fixed standalone
binary still linked the old033library and correctly failed; the actual Cargo JSON
receipt identifies the rebuilt root-package library alias and matchingf5metadata.
Devshell banners and a mistaken receipt-filename guard caused separate metadata
setup failures before compilation. All failed logs/binaries/source observations
remain. No assertion/source change makes a stale artifact pass. The baseline and
fixed native libraries have distinct identified transitive Cargo feature graphs;
the runtime-core write body itself has no feature-gated branch. Exact full rustc
argv for initial failed helpers was not separately logged; raw diagnostics remain.

Nine real compiler/build invocations include four failures; cached artifact receipt
retrieval is not another compile. New Node overload/error/flush/async obligations
and current guest/four-host behavior remain open. No finding/family closes and
pins/ABI/full rebuild/overall deferrals stay unchanged.
