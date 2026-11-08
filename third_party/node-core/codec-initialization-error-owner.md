# Codec constructor initialization error publication

The actual native codec Init error owner retains the same copied message used
for optional onerror delivery in a rooted JS string. Brotli still throws the
pinned generic "Initialization failed" text. Zstd throws the real Init or
SetParameter message (for example "Setting parameter failed"), as pinned
node_zlib.cc does. The original context's error-string pointer is never read
after user getter/callback/reset/close reentry. Actual codec errors and native
resource lifetime remain owned by the existing context/handle, not synthesized
codec success. Original callback/property exceptions stop publication unchanged.

Initialization now uses the same genuine native coded-error creation owner as
pledged-size errors: current-realm Error class, real stack capture and ordinary
checked code assignment. Inherited setters run, inherited nonwritable code may
leave no own property, and a throwing setter retains the pinned native checked
failure policy. Existing pledge TypeError/RangeError selection is unchanged.
Generic private ABI/state failure helpers and stream onerror transport are not
rewritten by this slice. The new helper is consumed immediately by both public
constructor initialization failures and the existing pledged-size owner.

Historical ZIP-007 blanket backing-kind rejection, ZIP-008 fractional numeric
admission and ZIP-009 required onerror absence prose no longer describes current
source. Those owners already exist; this change does not credit them again.
ZIP-009 remains partial: this fixes actual Zstd initialization text and modern
constructor error publication, not all errors/classes/metadata or lifecycles.
ZIP-010 capacity reporting is an independent already-integrated owner.

Source inspection and exact patch replay only; no new runtime tests, controls,
compilers, generation, package/overall suites, or guest execution. Constructor
allocator faults, true callback/fatal/checkpoint behavior, native GC/realm/Worker
and four-host conformance remain unvalidated. Full ZIP/iterator/Web/codec
behavior, disposal/transfer/OOM and shared stream/filesystem owners remain open.
