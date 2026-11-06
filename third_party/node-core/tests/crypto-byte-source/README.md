# Native crypto byte-source references

Run `run-reference.sh` under the declared dev shell with NODE26_REFERENCE set
to the exact audited native executable. There is no global setup, package
resolver, compiler, provisioning or overall suite. The twelve strict groups
use real Node crypto, async hooks and actual VM contexts. They check only the
reference behavior that a later candidate must satisfy.

V8's VM objects are not SpiderMonkey security CCWs. No candidate JSAPI helper,
GC/no-GC boundary, native backing capability or work queue executes here.
Allowed/denied security wrappers, actual inline/pinned storage and all guest/
four-host paths require identified compiled-candidate validation later.

The initial control incorrectly expected Hash's invalid-Proxy type formatter
not to read getters. Pinned internal/errors.js determineSpecificType reads
constructor.name; that original failure is retained in the handoff evidence.
The corrected control asserts the real formatting exception and separately
verifies native timingSafeEqual's getter-free invalid-type path.
