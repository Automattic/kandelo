# Shared native crypto error ownership

The pinned Node 26.13.0 queue capture and decoration algorithms are selected
from verified upstream sources by `generate-crypto-errors.py`. The checked-in
header retains the actual OpenSSL queue order, primary error number and owned
message/decoration strings. Native workers transfer C++ values, never engine
values or provider-owned string pointers.

The engine creates a genuine Error in the current owning realm and roots it
through ordinary property assignments. Assignment order is the reversed error
stack, the first remaining queue error's library/function/reason/code, then an
explicit primary error's decoration. Nonthrowing assignment refusal is ignored;
a setter exception is preserved. Stack array elements are own properties.
Messages and stack strings use UTF-8; decoration strings use the pin's Latin1
conversion. The JS crypto adapters propagate the original native Error rather
than creating and decorating another Error.

Native Node error-code macros use a distinct checked assignment policy: a
throwing inherited code setter is fatal. CryptoErrorStore's optional Node code
uses ordinary exception propagation. Constructor errors and KDF result errors
retain that distinction. Tiny isolated controls preserve and compare that
fatal policy separately from ordinary throwing-setter cases.

This is shared error ownership, not complete crypto compatibility. Existing
special comparison/validation errors, TLS verification errors and unrelated
native error helpers are outside this slice. The shared JSAPI implementation
has source/staging checks but has not been compiled or executed in this
candidate. Native portable components use the exact native Node executable's
exported OpenSSL/ncrypto, not the guest dependency artifact. Error stack frame
formatting, all async-hooks contexts, cancellation/termination, allocation
accounting and four-host conformance remain unvalidated. OpenSSL/C++ opaque
allocation capacity is not represented by logical message length or claimed
as RSS.
