# Runtime-owned default locale source

Source checkpoint 148 adds a private OS/config locale provider backed by real
engine-owned initialization state. It does not add a public os locale method,
Navigator, CPU measurements or a fabricated processor count. CPU capacity,
topology and affinity remain implementation gaps; os.cpus and
os.availableParallelism keep their explicit unsupported errors.

The canonicalizer uses the pinned V8 default-locale policy over ICU Locale
parsing and language-tag conversion. It uses neither mutable public Intl
methods nor current process.env. The actual Node bootstrap constructs the OS
owner before user entry and captures the real runtime default at that point.
Later private calls read the native owner again, so explicit native locale
set/reset remains observable instead of being hidden by a JavaScript cache.

Four engine files retain an owned original locale identifier alongside the
existing normalized locale. Existing normalization loses information: the
actual ICU keyword input en_US@timezone=America/Los_Angeles produces
en-US-u-tz-uslax, while replacing every underscore first corrupts the keyword.
The original identifier is therefore copied before normalization. Set and
initialization commit both owned strings only after both allocations succeed;
reset and runtime destruction retire both. The public embedding getter
returns its own copy. Runtime size accounting includes both real allocations.
Existing normalized/public Intl behavior and per-realm override policy remain
separate from this private provider.

The normal package declares and stages the new header. Engine patch 0118
applies only to the four exact Mozilla preimages; no preceding recipe patch
touches those files. Their complete preimages match the pinned Mozilla
archive. The source/native reference pin remains Node 26.13.0. No libc,
kernel/host ABI, shared-memory ceiling or platform identity changes, and no
artifact is relabeled as current.

The dependency review verified that Mozilla 140 retains ICU4C 77.1 alongside
ICU4X. The required headers and Locale/ByteSink implementations belong to the
existing static ICU-to-JS-to-shell link path. The actual integrated header
compiles against those archive headers with static ICU defines, exceptions
enabled and RTTI disabled. This proves API/header availability, not the guest
engine's final link. No additional library or pin change was justified.

Existing sealed evidence retains ten exact native startup observations,
Worker and before-first-access timing controls, fourteen actual header/ICU78
comparisons against V8, and extracted runtime-cache allocation-failure and
ownership controls. These are explicitly scoped native/component results.
The actual Mozilla ICU77 language-tag source is identical to the target's
ICU78 file, but other Locale implementation and resource-data differences
remain unvalidated. No concrete version-induced mismatch was found; version
numbers alone establish neither equivalence nor an accepted platform boundary.

Root verification passes normal source/input/unity staging, the actual-header
ICU77 compilation, a production JS/private locale frontend control over its
declared native ICU78 dependency, and complete bootstrap syntax. Twenty-one
affected checks pass without skips: seven OS frontend controls and fourteen
package-source checks. The existing OS fixture now obtains its new private
locale dependency from the same pinned native config owner, separately from
its optional POSIX transport helper. Public assertions are unchanged.

The original external-header warning compile failure and missing-header input
observation remain preserved in the sealed evidence. No production warning or
assertion was suppressed. The combined SpiderMonkey C++/JSAPI/runtime layout,
actual guest ICU77 final linking and parsing/data/error behavior, startup and
Worker timing, GC/realm/OOM handling and ordinary Intl nonregression remain
unvalidated. No current four-host conformance, API closure or completed family
is claimed. No overall suite or full product rebuild ran.

Exact source and evidence identities:
[default-locale-finding-progress.json](default-locale-finding-progress.json).
