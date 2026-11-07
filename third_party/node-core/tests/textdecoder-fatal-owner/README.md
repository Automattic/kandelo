# Decoder fatal-error stream ownership

The actual shared TextDecoder state now preserves the current stream/flush
policy on fatal conversion failure. It retires pending decoder byte/code-point
state and restores only the previously successful BOM state. A failed call
must not publish BOM state from an emitted prefix whose result was discarded.
Existing nonstream reset, ignoreBOM and nonfatal conversion remain owned by
the real decoder. This follows pinned internal/encoding.js successful-call
BOM publication/error chunk cleanup and node_i18n.cc successful-only BOM
publication, not a new support flag or native-host production decoder.

control.cjs compares actual extracted production decoder against the pinned
native decoder with stream/error/recovery/flush byte sequences. Slow mode
runs real state machine; fast mode provides an explicit native valid-UTF8-only
conversion dependency, as the production native primitive would. preload.cjs
installs that actual source class for unchanged focused upstream files.
Native fixture dependencies do not prove new guest or four-host behavior.

Twenty groups cover established/prior/partial/split BOM state, original fatal
code/message, invalid continuation, repeated failure, pending flush, fresh
nonstream reset, ignoreBOM/nonfatal policy and UTF16LE/BE recovery. Four unchanged
upstream fatal-streaming/fatal/ignoreBOM/UTF16-surrogate files pass in native and
both candidate modes. Original eight-group baseline mismatches remain retained.
Full encoding repertoire, input/options/constructor conversion chronology,
inspection/brands/descriptors and concurrent/detached/growable bytes require
separate work or identified guest validation; no exclusion is accepted here.
