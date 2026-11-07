# Zstd pledged-size admission

The existing codec owner uses the exact pinned Zstd::Init admission policy for
pledgedSrcSize. Undefined retains the actual unknown-size sentinel. Other values
must be primitive numbers, then safe integers, then nonnegative. Fractional sizes
are rejected rather than receiving zlib level/flush Int32/Uint32 conversion.
Negative zero is valid. The safe-integer error precedes the nonnegative error.

codec-pledge.h holds the shared portable policy. CodecInit consumes it for both
Zstd modes; the existing real contexts, allocator, byte/async/close owners and
unchanged pinned public wrappers remain in place. The engine raises genuine
TypeError/RangeError with the target native messages/codes. Ordinary code-setting
invokes inherited setters, ignores a nonthrowing false result and retains the
native checked-failure policy for a throwing setter. Other codec error branches
are not rewritten or claimed by this change.

Focused controls compile the actual portable policy and use the unchanged public
zlib source with real native codec/stream/async/Buffer dependencies. The native
control must run its own InitStream before validation errors for its wrapper's
lifetime. Its validation errors cannot serve as a fallback: if it rejects a
pledged-size argument, the candidate policy must independently reject it or the
control fails. This explicitly bounded dependency sequence does not compile or
execute the production SpiderMonkey error constructor or establish exact guest
callback/realm/lifecycle behavior. Native error setter call counts are not
inferred from that compound control path.

Initial control attempts recursed through a shadowed init function and abandoned
uninitialized native handles, producing stack overflow and GC aborts. The raw
nonpasses remain preserved. Standalone native-only rejected-constructor/GC cases
for NaN and string both survived; no Node fault or production runtime workaround
was established. No original assertion or upstream source was weakened.

Current four-host provider/realm/error/fault/GC/teardown conformance, complete
native allocation accounting, ZIP/iterable/Web/stream dependencies and other
qualified compression findings remain open. This is one native argument/error
owner correction, not complete compression compatibility or a performance claim.
