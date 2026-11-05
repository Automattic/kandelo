# Original Codex transform on the final lexical source

The exact original 284,605,220-byte input completed the native transform
on the final production source. The 16 GiB physical-memory guard and
30-minute deadline did not fire. Normal compiler-fact analysis completed
without fallback. Serial Wasm validation and atomic publication succeeded;
the published file's hash was checked independently afterward.

| Measurement | Result |
|---|---:|
| Complete transform wall time | 1029.34 seconds (17m 9.34s) |
| OS lifetime peak physical footprint | 484.97 MiB |
| Peak requested Rust allocations | 430.94 MiB |
| Maximum sampled RSS | 927.75 MiB |
| Output | 246,465,071 bytes |

The measurement includes bounded immutable file snapshots, compiler-fact
and sink analysis, frozen planning, per-function rewriting and emission,
feature metadata, serial structural validation, atomic publication and
checksums. This was one serial transform through the declared arm64 macOS
development shell, with `RAYON_NUM_THREADS=2`. Other workspaces still had
serial builds. Its wall time is a capacity observation, not a matched
throughput comparison.

No Binaryen, Node validator, browser, guest execution or Codex execution
ran on this large input/output. The output remains a private diagnostic
artifact, not an admitted or shipped package.

## Fingerprints

- Original input SHA-256: `17b829246d2396cf73f60d3dee8fea1b64dbbae8b96b0825d7228ce288ef7e42`
- Published output SHA-256: `a0310b790bb90acc1661cff69bc75fbf138ce5675da780e8e29d1d9db1188e0f`
- Measured executable SHA-256: `19f09572f6034995846f67b2c77739368ff37daa9d76b8211f5ae5e749c8467d`
- Last production-code commit: `b4584a5ddf2b0d40e83a9e94e7f77bf227c4a3cf`
- ABI descriptor fingerprint: `8dc038bd00ac9c52072f0f0db1a2362f28094e5b408447c691c0d1006fcc07bc`
- Unchanged data payload fingerprint: `23dc62254d667427322745aa51b73682787e685d370665de878f8e4a174662ca`

The exact 204-file source snapshot, executable and source manifest are
preserved in `.context/native-lexical-replay-build/`. Its source base is
`67214f18167185831970fc53a44fd2f646482f0c`, with the preserved lexical-replay delta
subsequently committed in the production commit above. Later commits add
measurements, tests and documentation; the production source is unchanged.
The [machine-readable record](2026-10-24-native-codex-lexical-transform.json)
contains exact byte counts, guard settings and provenance. Raw traces,
stdout/stderr, copied run script and input/output are retained in
`.context/native-codex-lexical-20261024/`.

## Boundaries and earlier evidence

The [earlier shared-target checkpoint](2026-10-24-native-codex-transform.md)
completed at 451.38 MiB physical peak in 1,073.45 seconds, with a different
source/executable fingerprint. Its data remains separately attributed.
The physical peaks differ between runs; these observations do not isolate
a causal memory or speed effect of lexical replay. Requested Rust peaks
are both about 430.94 MiB.

The historical unchanged Walrus attempt exceeded its 16 GiB guard during
analysis and produced no output. It was not repeated. Different stopping
points do not establish a completed-transform timing ratio or a memory
ratio at the same endpoint.

Physical footprint differs from RSS; clean mapped input/output pages are
reclaimable. Requested Rust allocations exclude SQLite/C allocations,
native stacks and allocator overhead. Temporary disk storage is additional.
The guards observe actual consumption; their ceilings are not reservations
or the explanation for the low measured working set.
