# musl `__lookup_name()` Override Design

**Date:** 2026-03-14
**Status:** Approved

## Goal

Replace musl's `__lookup_name()` with a Wasm-compatible version that routes DNS resolution through syscall #140 (`SYS_GETADDRINFO`) instead of attempting UDP socket-based DNS queries.

## Problem

musl's `__lookup_name()` calls `name_from_dns_search()` → `__res_msend_rc()`, which opens UDP sockets to nameservers from `/etc/resolv.conf`. Neither the file nor UDP DNS works in the Wasm kernel. The kernel already has a working `SYS_GETADDRINFO` syscall (#140) that delegates to the host, but musl never calls it.

## Approach

Create `musl-overlay/src/network/lookup_name.c` to replace the original. The build script already copies overlay source files into the musl tree. No other files need to change.

## Resolution Pipeline

The override handles three cases in order:

1. **NULL/empty name** — Return loopback (`127.0.0.1`) or wildcard (`0.0.0.0`) depending on `AI_PASSIVE` flag. No syscall.

2. **Numeric IP** — Call musl's internal `__lookup_ipliteral()` to parse addresses like `"192.168.1.1"`. No syscall.

3. **Hostname** — Call `__syscall2(SYS_getaddrinfo, name, result_buf)`. Read back 4 bytes of IPv4, pack into `struct address`.

## Syscall Protocol

Existing protocol (no changes needed):
- **Input:** `a1` = hostname string pointer (null-terminated), `a2` = result buffer pointer
- **Glue:** Computes string length, calls `kernel_getaddrinfo(name_ptr, name_len, result_ptr)`
- **Output:** 4 bytes of raw IPv4 address in network byte order, return value = bytes written (4) or negated errno

## Error Mapping

| Kernel error | `EAI_*` code |
|-------------|-------------|
| `-ENOENT` | `EAI_NONAME` |
| `-EINVAL` | `EAI_FAIL` |
| other | `EAI_FAIL` |

## Result Packing

```c
buf[0].family = AF_INET;
buf[0].scopeid = 0;
memset(buf[0].addr, 0, 16);
memcpy(buf[0].addr, result, 4);
buf[0].sortkey = 0;
// canon = input name
// return 1
```

## Scope

- Single IPv4 address only (matches current host backend protocol)
- No IPv6 support (deferred)
- No multiple-result support (deferred)
- No `/etc/hosts` lookup (could add later, but host handles it)

## Files Changed

- Create: `musl-overlay/src/network/lookup_name.c`

## Testing

1. Rebuild musl (`scripts/build-musl.sh`) — verify compilation succeeds
2. Compile a test program calling `getaddrinfo()` — verify it links
3. Host integration test — resolve a real hostname through the full chain
