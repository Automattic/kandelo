# QuickJS-NG Node Compat — Phase 0 Verification

Date: 2026-04-29
Branch: `explore-node-wasm-docs-quickjs-phase0` (stacked on `explore-node-wasm-fix-quickjs-eval-stack-size`)

## Build chain — all green

| Step | Output | Size | Status |
|------|--------|------|--------|
| musl    | `sysroot/lib/libc.a`                         | 1.4 MB  | ✓ |
| kernel  | `host/wasm/wasm_posix_kernel.wasm`           | 416 KB  | ✓ |
| OpenSSL | `examples/libs/openssl/openssl-install/lib/libcrypto.a` | 4.9 MB  | ✓ |
| OpenSSL | `examples/libs/openssl/openssl-install/lib/libssl.a`    | 1.2 MB  | ✓ |
| zlib    | `examples/libs/zlib/zlib-install/lib/libz.a`            | 100 KB  | ✓ |
| qjs     | `examples/libs/quickjs/bin/qjs.wasm`         | 1.95 MB | ✓ |
| node    | `examples/libs/quickjs/bin/node.wasm`        | 2.17 MB | ✓ |

## Vitest — node-compat.test.ts

12 / 12 pass. Pre-fix this was 1 / 12 — the only previously-passing case was `--version`, which short-circuits before `JS_Eval`. The Phase 0c stack-size fix unblocked the other 11.

## Eval smoke

`host/test/quickjs-eval-smoke.test.ts` — 4 cases pass:

| binary | expression | output |
|--------|-----------|--------|
| qjs    | `print(1+1)`                              | `2`     |
| qjs    | `print('hello')`                          | `hello` |
| qjs    | `print([1,2,3].map(x=>x*2).join(','))`    | `2,4,6` |
| node   | `console.log(1+1)`                        | `2`     |

## OpenSSL audit

```
$ strings examples/libs/openssl/openssl-install/lib/libcrypto.a | grep -E '^OPENSSLDIR|^/etc/ssl'
/etc/ssl/ct_log_list.cnf
OPENSSLDIR: "/etc/ssl"
/etc/ssl
/etc/ssl/private
/etc/ssl
```

Confirmed: `OPENSSLDIR=/etc/ssl`, expected cert paths embedded.

## zlib audit

`libz.a` — 100 KB. No further surface checks at this phase; Phase 2 wires zlib into the `qjs:node` native module.

## Tarball roundtrip

```
$ curl -sSL https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz -o /tmp/lodash-probe/lodash.tgz
$ file /tmp/lodash-probe/lodash.tgz
/tmp/lodash-probe/lodash.tgz: gzip compressed data, from Unix, original size modulo 2^32 2269184
$ shasum -a 256 /tmp/lodash-probe/lodash.tgz
6a087ac9e5702a0c9d60fbcd48696012646ec8df1491dea472b150e79fcaf804  /tmp/lodash-probe/lodash.tgz
```

Matches the published sha256 for `lodash@4.17.21`. In-kernel tarball verification is in scope for Phase 5.

## Foundation fixes shipped

- `fix(toolchain): __tls_ snapshot filter + __c_longjmp tag fix + v7 fold` — branch `explore-node-wasm-fix-build-toolchain` (PR #8)
- `fix(quickjs): drop nonexistent cutils.c refs from build-quickjs.sh` — branch `explore-node-wasm-fix-quickjs-cutils-c`
- `fix(quickjs): bump wasm stack-size to 8 MiB — restore JS_Eval` — branch `explore-node-wasm-fix-quickjs-eval-stack-size`

All three branches stacked; only PR #8 is currently open. Phases 0b/0c live as commits on their branches awaiting explicit PR authorization.

## Gauntlet (per CLAUDE.md)

| Suite | Result |
|-------|--------|
| `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` | 773 / 0 fail |
| `cd host && npx vitest run`                                          | 297 pass / 0 fail / 90 skip |
| `scripts/run-libc-tests.sh`                                          | exit 0 (XFAIL + TIME only) |
| `scripts/run-posix-tests.sh`                                         | exit 0 (SKIP only) |
| `scripts/check-abi-version.sh`                                       | clean (v7 consistent) |

Phase 0 is complete. Next: Phase 1 — hashing via libcrypto.
