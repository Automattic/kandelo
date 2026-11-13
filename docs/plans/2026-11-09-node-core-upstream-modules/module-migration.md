# Module migration ledger

Planning only. All 74 audited module surfaces receive whole-file replacements from the same pin. Shared native candidates and missing prerequisites are described by family in [the design](README.md); exact direct JS/binding edges and source hashes are in [module-migration.json](module-migration.json). Transitive and lazy dependencies are in [dependency-graph.json](dependency-graph.json). No row denotes implemented support.

Every row has these dispositions: retain its tests/audit/evidence; replace its public factory or selected-function assembly; consider the family native owners for reuse; keep platform/ABI changes separate. No public algorithm patch is proposed. Engine/private-slot adaptations are explicitly reviewed in the design.

Wave 0 = environment design/import preparation; 1 = shared foundation and first slice; 2 = OS/stream/process/worker/loading expansion; 3 = protocol/codec/web consumers; 4 = diagnostics/engine/testing/native integration. Prerequisites override wave numbers.

| Public module | Whole upstream file | Family / wave | Direct native bindings (transitive bindings additional) |
|---|---|---|---|
| `node:_http_agent` | `lib/_http_agent.js` | http / 3 | `stream_wrap` |
| `node:_http_client` | `lib/_http_client.js` | http / 3 | None directly |
| `node:_http_common` | `lib/_http_common.js` | http / 3 | `http_parser` |
| `node:_http_incoming` | `lib/_http_incoming.js` | http / 3 | None directly |
| `node:_http_outgoing` | `lib/_http_outgoing.js` | http / 3 | None directly |
| `node:_http_server` | `lib/_http_server.js` | http / 3 | `http_parser` |
| `node:_tls_common` | `lib/_tls_common.js` | secure-network / 3 then 4 | None directly |
| `node:_tls_wrap` | `lib/_tls_wrap.js` | secure-network / 3 then 4 | None directly |
| `node:assert` | `lib/assert.js` | values / 1 | None directly |
| `node:assert/strict` | `lib/assert/strict.js` | values / 1 | None directly |
| `node:async_hooks` | `lib/async_hooks.js` | async / 1 | None directly |
| `node:bench` | `lib/bench.js` | testing / 4 | None directly |
| `node:bench/reporters` | `lib/bench/reporters.js` | testing / 4 | None directly |
| `node:buffer` | `lib/buffer.js` | values / 1 | `buffer`, `config`, `icu`, `util` |
| `node:child_process` | `lib/child_process.js` | processes / 2 | `pipe_wrap`, `process_wrap` |
| `node:cluster` | `lib/cluster.js` | processes / 2 | None directly |
| `node:console` | `lib/console.js` | observability / 4 | None directly |
| `node:constants` | `lib/constants.js` | values / 1 | `constants` |
| `node:crypto` | `lib/crypto.js` | crypto / 3 | `constants`, `crypto` |
| `node:dgram` | `lib/dgram.js` | network / 3 | `constants`, `udp_wrap` |
| `node:diagnostics_channel` | `lib/diagnostics_channel.js` | async / 1 | `diagnostics_channel`, `errors` |
| `node:dns` | `lib/dns.js` | network / 3 | `cares_wrap` |
| `node:dns/promises` | `lib/dns/promises.js` | network / 3 | None directly |
| `node:domain` | `lib/domain.js` | async / 1 | None directly |
| `node:dtls` | `lib/dtls.js` | secure-network / 3 then 4 | None directly |
| `node:events` | `lib/events.js` | async / 1 | None directly |
| `node:ffi` | `lib/ffi.js` | native-integration / 4 | `ffi` |
| `node:fs` | `lib/fs.js` | filesystem / 1 then 2 | `constants`, `fs` |
| `node:fs/promises` | `lib/fs/promises.js` | filesystem / 1 then 2 | None directly |
| `node:http` | `lib/http.js` | http / 3 | `buffer` |
| `node:http2` | `lib/http2.js` | http / 3 | None directly |
| `node:https` | `lib/https.js` | http / 3 | None directly |
| `node:inspector` | `lib/inspector.js` | engine / 4 | `config`, `inspector`, `process_methods` |
| `node:inspector/promises` | `lib/inspector/promises.js` | engine / 4 | None directly |
| `node:module` | `lib/module.js` | loading / 0 then 1 | None directly |
| `node:net` | `lib/net.js` | network / 3 | `cares_wrap`, `pipe_wrap`, `stream_wrap`, `tcp_wrap`, `uv` |
| `node:os` | `lib/os.js` | processes / 2 | `constants`, `credentials`, `os` |
| `node:path` | `lib/path.js` | values / 1 | None directly |
| `node:path/posix` | `lib/path/posix.js` | values / 1 | None directly |
| `node:path/win32` | `lib/path/win32.js` | values / 1 | None directly |
| `node:perf_hooks` | `lib/perf_hooks.js` | observability / 4 | `performance` |
| `node:process` | `lib/process.js` | processes / 2 | None directly |
| `node:punycode` | `lib/punycode.js` | values / 1 | `util` |
| `node:querystring` | `lib/querystring.js` | values / 1 | None directly |
| `node:quic` | `lib/quic.js` | secure-network / 3 then 4 | None directly |
| `node:readline` | `lib/readline.js` | terminal / 2 | None directly |
| `node:readline/promises` | `lib/readline/promises.js` | terminal / 2 | None directly |
| `node:repl` | `lib/repl.js` | terminal / 2 | `contextify` |
| `node:sea` | `lib/sea.js` | native-integration / 4 | `sea` |
| `node:sqlite` | `lib/sqlite.js` | native-integration / 4 | `sqlite` |
| `node:stream` | `lib/stream.js` | streams / 2 | None directly |
| `node:stream/consumers` | `lib/stream/consumers.js` | streams / 2 | None directly |
| `node:stream/iter` | `lib/stream/iter.js` | streams / 2 | None directly |
| `node:stream/promises` | `lib/stream/promises.js` | streams / 2 | None directly |
| `node:stream/web` | `lib/stream/web.js` | web / 2 then 3 | None directly |
| `node:string_decoder` | `lib/string_decoder.js` | values / 1 | `string_decoder` |
| `node:sys` | `lib/sys.js` | values / 1 | None directly |
| `node:test` | `lib/test.js` | testing / 4 | None directly |
| `node:test/reporters` | `lib/test/reporters.js` | testing / 4 | None directly |
| `node:timers` | `lib/timers.js` | async / 1 | `timers` |
| `node:timers/promises` | `lib/timers/promises.js` | async / 1 | None directly |
| `node:tls` | `lib/tls.js` | secure-network / 3 then 4 | `cares_wrap`, `crypto` |
| `node:trace_events` | `lib/trace_events.js` | observability / 4 | `config`, `trace_events` |
| `node:tty` | `lib/tty.js` | terminal / 2 | `tty_wrap` |
| `node:url` | `lib/url.js` | values / 1 | `encoding_binding`, `url`, `url_pattern`, `util` |
| `node:util` | `lib/util.js` | values / 1 | `util` |
| `node:util/types` | `lib/util/types.js` | values / 1 | None directly |
| `node:v8` | `lib/v8.js` | engine / 4 | `config`, `heap_utils`, `profiler`, `serdes`, `v8` |
| `node:vfs` | `lib/vfs.js` | filesystem / 1 then 2 | None directly |
| `node:vm` | `lib/vm.js` | engine / 4 | `contextify`, `symbols` |
| `node:wasi` | `lib/wasi.js` | native-integration / 4 | `wasi` |
| `node:worker_threads` | `lib/worker_threads.js` | workers / 2 | None directly |
| `node:zlib` | `lib/zlib.js` | compression / 3 | `constants`, `zlib` |
| `node:zlib/iter` | `lib/zlib/iter.js` | compression / 3 | None directly |
