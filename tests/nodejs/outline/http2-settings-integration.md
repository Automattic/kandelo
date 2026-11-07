# HTTP/2 settings and protocol source integration

Source164 adds a standalone protocol/settings owner over pinned Node26.13.0
algorithms and actual private Buffer numeric/unpooled allocation owners.
Protocol constants are derived from Node/nghttp2 source, not captured output.
The implemented public surface is constants, getDefaultSettings,
getPackedSettings, getUnpackedSettings and sensitiveHeaders. Six public
exports remain absent: connect, createServer, createSecureServer,
performServerHandshake, Http2ServerRequest and Http2ServerResponse.

This is not HTTP/2 transport support. Sessions/streams, HPACK, frame I/O,
ALPN/TLS, flow control and asynchronous ownership remain implementation gaps.
253 constant descriptors and five implemented export shapes match the native
control; this does not establish complete namespace shape or API conformance.

Current source checks guard776inputs.87semantic component cases pass; the
whole unchanged selected upstream test-http2-getpackedsettings.js executes
74assertions per native/candidate subject, one discovered/run file, zero
excluded files or skips.14affected package checks pass. Native memory/type/
process dependencies are explicit. No new compilation, production guest or
four-host acceptance is claimed. The negative omission control fails two
cases, and initial generator grammar failures remain preserved in evidence.

A root assembly review helper incorrectly anticipated a syntax error from
escaped tool output. The actual pinned parser passed before any attempted
edit; AST inspection confirmed real newline literals. The helper's failed
assertion and explicit retraction are retained. No assembly/runtime defect
or corrective source edit resulted.

See [source boundary](../../../third_party/node-core/http2-settings.md) and
[durable finding ledger](http2-settings-finding-progress.json).
