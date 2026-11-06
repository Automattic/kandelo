# Explicit Kandelo SpiderMonkey target

The recipe's Mozilla target is `wasm32-unknown-kandelo`. It retains the
SDK's actual LLVM target (`wasm32-unknown-unknown`), Wasm/Unix macros and
musl ABI. The recipe-local `__kandelo__` marker is accepted by Mozilla's
compiler check only with actual Wasm32 and Unix identity and without
Linux, WASI or Emscripten identity. The source configuration rules select
`OS_ARCH=Kandelo`, `OS_TARGET=Kandelo`, `TARGET_KERNEL=Kandelo`, `XP_UNIX`
and `XP_KANDELO`; they do not select `XP_LINUX`. A complete configure run
is still required to validate generated products.

Source checkpoint137 integrates this configuration in
`packages/registry/spidermonkey/patches/0110-kandelo-platform-target.patch`
and the ordinary engine recipe. This is not an engine/guest support claim.
Use a fresh normal resolver work root and coordinate the engine build
before validating artifacts. The original Linux Rust mapping in patch0002 is
replaced by an explicit ABI selection in the final composed source.
Rust's generic target retains `os=None`/`kernel=None` selection metadata
and actual `target_os="unknown"` cfg. It is not labeled Kandelo or Linux.
The current Rust dependency target and custom C/getrandom interop remain;
full Kandelo Rust std adoption is a separate SDK/sysroot/cache decision.

The target uses existing POSIX threading, clocks, memory mapping and
entropy-device owners. It explicitly retains musl's 15-byte thread-name
constraint. It uses the existing `DL_LIBS` configure result for Kandelo
rather than losing the SDK's functional dynamic-loading glue when the
Linux-only unconditional `-ldl` selection no longer applies. The Linux
libstdc++ compatibility option is removed from the recipe; the C++ runtime
remains the declared libc++ dependency. Public Node pins and identity,
SDK sources/macros, libc, kernel and ABI structures are unchanged.

`check-target.py` exercises exact pinned Mozilla configure function bodies
with actual SDK preprocessing, `config.sub` and `rustc --print` controls.
Decorators and complete configure dependency evaluation are outside its
scope. It requires preexisting source/pre/post trees and an explicitly
selected LLVM-matched plugin, and builds no toolchain or guest artifact:

```
WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh python3 \
  third_party/spidermonkey-target/check-target.py \
  --raw /absolute/pinned-mozilla-raw \
  --pre /absolute/composed-preimage --post /absolute/proposed-postimage \
  --repo /absolute/repository \
  --plugin /absolute/existing/LLVM-matched/KandeloCallTypes.dylib \
  --output /absolute/private/evidence
```

A version-constructor identity dependency is explicit in that focused
control; Xcode/version conversion is not tested. SDK header/symbol or
syntax controls do not establish runtime semantics. Complete configure,
engine C++/Rust build, linker/import checks, GC/thread/timer/random/dlopen
execution, Node behavior and the four product hosts remain unvalidated.
The existing process-creation precision gap stays visible: Kandelo's
`/proc/<pid>/stat` starttime is currently zero, so the old Linux algorithm
was not a truthful process-birth owner. Mozilla's generic fallback uses
its actual first initialization timestamp, not authoritative kernel birth.
No new zero uptime, fake memory state or success stub is introduced.
