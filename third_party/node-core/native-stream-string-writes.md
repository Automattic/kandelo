# Retained native stream string writes

The actual Socket consumer retains primitive strings and their encoding while
connecting. At native admission it consumes the pinned `writeGeneric` switch:
UTF8/UTF-8, ASCII, Latin1/binary and UCS2/UTF16LE aliases call genuine native
string methods on the already admitted TCP or terminal capability. Other
encodings retain the target's public Buffer.from fallback; this slice does not
claim all encodings avoid that deliberately public conversion owner. Typed
bytes still use the existing buffer/span path. Mixed string vectors remain
an explicit missing native owner.

The shared native encoder accepts only a primitive string, computes the pinned
StorageSize/INT_MAX admission, roots the string, allocates a private byte view,
then reacquires linear characters after allocation. UTF8 uses the existing
engine UTF8 owner, including replacement of unpaired surrogates. ASCII/Latin1
truncate code units to bytes and UCS2 writes little-endian code units using the
existing private StringBytes primitives. No public Buffer/from/valueOf/iterator
or constructor is called. The private view's actual backing is captured by
the existing retained Span owner and consumed by normal TCP/TTY write requests.
The original string/view can disappear while pending material stays alive.

Initial native progress, partial remainder, async init, request-frame/default
trigger, callback/error/ref/close/GC retirement remain owned by the existing
write queues. TTY composition depends on the preceding queued shutdown owner
and its immutable completion correction. Its EPIPE rejection now publishes
actual material bytes through the existing stream-state result owner. No
whole older bootstrap or generated bundle replaces current source264.

Focused native TCP component controls poison Buffer.from and String conversion
hooks after setup. Four primitive encodings and the unchanged typed-byte case
match pinned native wire observations; the old consumer fails all four string
cases. This checks the actual extracted Socket methods and exact selected
dispatcher over genuine native TCP/codec/stream dependencies. New C++ string
methods, private backing acquisition, guest realm/GC/OOM/fatal/Worker/provider
and four-host behavior remain uncompiled/unexecuted. No new compiler, normal
generation, product build or overall suite was run. Public TTY constructors
remain inactive. Full direct native supplied-request overload/prototype parity
and complete Socket behavior are not established by the null-request consumer
path used here.
