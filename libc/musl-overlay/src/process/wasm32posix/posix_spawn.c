/*
 * posix_spawn() for wasm32posix — non-forking implementation.
 *
 * Marshals argv + envp + file actions + spawn attributes into a single
 * contiguous blob and issues SYS_SPAWN. The kernel allocates a child pid,
 * builds the child process descriptor (with attrs and file actions
 * already applied), and the host launches a fresh worker — no fork, no
 * fork rewind, no exec replay.
 *
 * Wire format and design rationale:
 *   docs/plans/2026-05-04-non-forking-posix-spawn-design.md (Section 1).
 *
 * SYS_SPAWN channel args:
 *   arg0 = path_ptr        (caller memory; PATH-resolved by posix_spawnp)
 *   arg1 = path_len        (no NUL terminator counted)
 *   arg2 = blob_ptr        (caller memory)
 *   arg3 = blob_len
 *   arg4 = pid_out_ptr     (kernel writes child pid here on success)
 *   arg5 = 0               (reserved)
 *
 * Kernel returns 0 on success / -errno on failure. POSIX requires
 * posix_spawn() to return errno directly (not via the global errno), so
 * we negate the kernel return on the failure path.
 */

#define _GNU_SOURCE
#include <spawn.h>
#include <signal.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "../fdop.h"
#include "spawn_contract.h"

/* SYS_SPAWN syscall number — keep in lockstep with
 * `libc/glue/channel_syscall.c` and `crates/shared/src/lib.rs`. */
#define SYS_SPAWN 500

/* Wire-format file-action op codes. Distinct from the FDOP_* values used
 * by musl's internal fdop list (which fdop.h numbers 1..5). */
#define WIRE_OP_OPEN   0u
#define WIRE_OP_CLOSE  1u
#define WIRE_OP_DUP2   2u
#define WIRE_OP_CHDIR  3u
#define WIRE_OP_FCHDIR 4u

/* Matches the definition in libc/glue/channel_syscall.c — all six syscall args
 * are passed as long long (i64). Declaring them as plain `long` produces
 * an i32-vs-i64 signature mismatch at link time on wasm32. */
extern long __syscall6(long n, long long a1, long long a2, long long a3,
                       long long a4, long long a5, long long a6);

static const posix_spawnattr_t empty_attr;
static const posix_spawn_file_actions_t empty_fa;

static int checked_add_size(size_t lhs, size_t rhs, size_t *out)
{
	if (rhs > SIZE_MAX - lhs) return E2BIG;
	*out = lhs + rhs;
	return 0;
}

static int checked_mul_size(size_t lhs, size_t rhs, size_t *out)
{
	if (lhs != 0 && rhs > SIZE_MAX / lhs) return E2BIG;
	*out = lhs * rhs;
	return 0;
}

/* Count and size a NULL-terminated argv-style array without allowing either
 * arithmetic wraparound or a protocol count beyond the generated parser cap. */
static int scan_strings(char *const *list, unsigned max_count,
	unsigned *out_count, size_t *out_bytes)
{
	unsigned count = 0;
	size_t total = 0;
	if (list) {
		while (list[count]) {
			if (count >= max_count) return E2BIG;
			size_t len = strlen(list[count]);
			if (len == SIZE_MAX || checked_add_size(total, len + 1, &total))
				return E2BIG;
			count++;
		}
	}
	*out_count = count;
	*out_bytes = total;
	return 0;
}

/* Walk the fdop list to count actions and total path bytes that need to
 * land in the strings region. Path strings are stored once each, NUL-
 * terminated.
 *
 * NOTE on traversal direction: musl's `posix_spawn_file_actions_add*`
 * helpers PREPEND new entries (`op->next = fa->__actions; fa->__actions
 * = op;`), so iterating from `__actions` via `next` walks the list in
 * REVERSE insertion order. POSIX requires file actions to be applied in
 * insertion order, so the emit-side walk uses `op->prev` from the tail
 * — see `emit_actions`. The count/scan walk direction doesn't matter
 * (we only need totals). */
static int scan_actions(struct fdop *head, unsigned *out_count,
	size_t *out_path_bytes)
{
	unsigned n = 0;
	size_t path_bytes = 0;
	for (struct fdop *op = head; op; op = op->next) {
		if (n >= WASM_POSIX_SPAWN_MAX_ACTION_COUNT) return E2BIG;
		n++;
		if (op->cmd == FDOP_OPEN || op->cmd == FDOP_CHDIR) {
			size_t path_len = strlen(op->path);
			if (path_len >= WASM_POSIX_PATH_MAX_BYTES)
				return ENAMETOOLONG;
			if (checked_add_size(path_bytes, path_len + 1, &path_bytes))
				return E2BIG;
		}
	}
	*out_count = n;
	*out_path_bytes = path_bytes;
	return 0;
}

/* Translate musl's FDOP_* code into the wire-format op code. */
static unsigned wire_op_for(int cmd) {
	switch (cmd) {
	case FDOP_OPEN:   return WIRE_OP_OPEN;
	case FDOP_CLOSE:  return WIRE_OP_CLOSE;
	case FDOP_DUP2:   return WIRE_OP_DUP2;
	case FDOP_CHDIR:  return WIRE_OP_CHDIR;
	case FDOP_FCHDIR: return WIRE_OP_FCHDIR;
	default:          return (unsigned)-1;
	}
}

/* Reduce sigset_t to the kernel's 64-bit signal-mask convention (signals
 * 1..64 in low-order bits). musl's sigset_t is opaque here, so peek at
 * the first 8 bytes — same approach the kernel uses for setitimer/etc. */
static uint64_t sigset_to_u64(const sigset_t *s) {
	uint64_t v = 0;
	memcpy(&v, s, sizeof(v) <= sizeof(*s) ? sizeof(v) : sizeof(*s));
	return v;
}

int posix_spawn(pid_t *restrict res, const char *restrict path,
	const posix_spawn_file_actions_t *fa,
	const posix_spawnattr_t *restrict attr,
	char *const argv[restrict], char *const envp[restrict])
{
	if (!path) return EINVAL;
	if (strlen(path) >= WASM_POSIX_PATH_MAX_BYTES) return ENAMETOOLONG;

	const posix_spawnattr_t *a = attr ? attr : &empty_attr;
	const posix_spawn_file_actions_t *f = fa ? fa : &empty_fa;

	/* Resolve envp default: if the caller passed NULL, use environ. */
	extern char **__environ;
	char *const *env = envp ? envp : (char *const *)__environ;

	unsigned argc = 0;
	unsigned envc = 0;
	unsigned n_actions = 0;
	size_t argv_bytes = 0;
	size_t envp_bytes = 0;
	size_t action_path_bytes = 0;
	int error = scan_strings(argv, WASM_POSIX_SPAWN_MAX_ARGV_COUNT,
		&argc, &argv_bytes);
	if (error) return error;
	error = scan_strings(env, WASM_POSIX_SPAWN_MAX_ENVP_COUNT,
		&envc, &envp_bytes);
	if (error) return error;
	error = scan_actions((struct fdop *)f->__actions,
		&n_actions, &action_path_bytes);
	if (error) return error;

	/* ARG_MAX includes both string bytes and the source pointer arrays,
	 * including their two terminating NULL entries. */
	size_t pointer_count;
	size_t pointer_bytes;
	size_t metadata_bytes;
	if (checked_add_size((size_t)argc, (size_t)envc, &pointer_count)
	    || checked_add_size(pointer_count, 2, &pointer_count)
	    || checked_mul_size(pointer_count, sizeof(char *), &pointer_bytes)
	    || checked_add_size(argv_bytes, envp_bytes, &metadata_bytes)
	    || checked_add_size(metadata_bytes, pointer_bytes, &metadata_bytes))
		return E2BIG;
	if (metadata_bytes > WASM_POSIX_ARG_MAX_BYTES) return E2BIG;

	size_t header_bytes = WASM_POSIX_SPAWN_HEADER_BYTES;
	size_t argv_off_bytes;
	size_t envp_off_bytes;
	size_t actions_bytes;
	size_t strings_bytes;
	size_t blob_len;
	if (checked_mul_size((size_t)argc, sizeof(uint32_t), &argv_off_bytes)
	    || checked_mul_size((size_t)envc, sizeof(uint32_t), &envp_off_bytes)
	    || checked_mul_size((size_t)n_actions,
		WASM_POSIX_SPAWN_ACTION_RECORD_BYTES, &actions_bytes)
	    || checked_add_size(argv_bytes, envp_bytes, &strings_bytes)
	    || checked_add_size(strings_bytes, action_path_bytes, &strings_bytes)
	    || checked_add_size(header_bytes, argv_off_bytes, &blob_len)
	    || checked_add_size(blob_len, envp_off_bytes, &blob_len)
	    || checked_add_size(blob_len, actions_bytes, &blob_len)
	    || checked_add_size(blob_len, strings_bytes, &blob_len))
		return E2BIG;
	if (blob_len > WASM_POSIX_SPAWN_WIRE_MAX_BYTES) return E2BIG;

	/* Allocate on the heap; alloca() of unbounded size is unsafe and
	 * fork-instrument's switch-dispatch interacts poorly with large
	 * stack frames in spawn-heavy programs. The blob is short-lived. */
	uint8_t *blob = malloc(blob_len);
	if (!blob) return ENOMEM;

	/* ── Header ── */
	uint32_t *h32 = (uint32_t *)blob;
	int32_t  *h32s = (int32_t *)blob;
	h32[0] = argc;
	h32[1] = envc;
	h32[2] = n_actions;
	h32[3] = (uint32_t)a->__flags;
	h32s[4] = (int32_t)a->__pgrp;
	h32[5] = 0; /* _pad */
	uint64_t sigdef  = sigset_to_u64(&a->__def);
	uint64_t sigmask = sigset_to_u64(&a->__mask);
	memcpy(blob + 24, &sigdef,  8);
	memcpy(blob + 32, &sigmask, 8);

	/* ── Offsets tables + strings region ──
	 *
	 * Argv strings come first in `strings`, then envp, then action
	 * paths. Each block is packed: NUL-terminated, no padding. */
	uint32_t *argv_offs = (uint32_t *)(blob + header_bytes);
	uint32_t *envp_offs = (uint32_t *)(blob + header_bytes + argv_off_bytes);
	uint8_t  *actions   =  blob + header_bytes + argv_off_bytes + envp_off_bytes;
	uint8_t  *strings   =  actions + actions_bytes;

	uint32_t cursor = 0;
	for (unsigned i = 0; i < argc; i++) {
		size_t n = strlen(argv[i]) + 1;
		memcpy(strings + cursor, argv[i], n);
		argv_offs[i] = cursor;
		cursor += (uint32_t)n;
	}
	for (unsigned i = 0; i < envc; i++) {
		size_t n = strlen(env[i]) + 1;
		memcpy(strings + cursor, env[i], n);
		envp_offs[i] = cursor;
		cursor += (uint32_t)n;
	}

	/* ── Action records (POSIX-required INSERTION order) ──
	 *
	 * musl's `posix_spawn_file_actions_add*` helpers prepend to the
	 * linked list, so `fa->__actions` is the most-recently-added entry
	 * and the list is reverse-insertion order. To emit insertion
	 * order, walk to the tail first, then iterate via `prev`.
	 *
	 * Wire-format `record.fd` and `record.newfd` (offsets +4 and +8) map
	 * to musl's fdop fields differently per op:
	 *   * DUP2: record.fd  = op->srcfd (source)
	 *           record.newfd = op->fd  (target)
	 *   * CLOSE/OPEN/FCHDIR: record.fd = op->fd
	 *                       record.newfd = unused (0)
	 *   * CHDIR: both unused (0); only `path` carries information.
	 *
	 * The kernel parser (`crates/kernel/src/spawn.rs::parse_blob`) reads
	 * the same two slots for every op and dispatches via the op code, so
	 * mis-encoding here would silently corrupt DUP2 actions. */
	struct fdop *tail = (struct fdop *)f->__actions;
	if (tail) {
		while (tail->next) tail = tail->next;
	}
	unsigned ai = 0;
	for (struct fdop *op = tail; op; op = op->prev) {
		uint32_t *r32  = (uint32_t *)(actions
			+ ai * WASM_POSIX_SPAWN_ACTION_RECORD_BYTES);
		int32_t  *r32s = (int32_t  *)(actions
			+ ai * WASM_POSIX_SPAWN_ACTION_RECORD_BYTES);
		r32[0] = wire_op_for(op->cmd);
		if (op->cmd == FDOP_DUP2) {
			r32s[1] = op->srcfd;  /* record.fd    = source */
			r32s[2] = op->fd;     /* record.newfd = target */
		} else {
			r32s[1] = op->fd;
			r32s[2] = 0;
		}
		uint32_t path_off = 0;
		uint32_t path_len = 0;
		if (op->cmd == FDOP_OPEN || op->cmd == FDOP_CHDIR) {
			path_off = cursor;
			path_len = (uint32_t)strlen(op->path) + 1;
			memcpy(strings + cursor, op->path, path_len);
			cursor += path_len;
		}
		r32[3]  = path_off;
		r32[4]  = path_len;
		r32s[5] = op->oflag;
		r32[6]  = (uint32_t)op->mode;
		ai++;
	}

	/* ── Issue SYS_SPAWN ── */
	pid_t pid_out = 0;
	long ret = __syscall6(
		SYS_SPAWN,
		(long long)(uintptr_t)path,
		(long long)strlen(path),
		(long long)(uintptr_t)blob,
		(long long)blob_len,
		(long long)(uintptr_t)&pid_out,
		0LL
	);

	free(blob);

	if (ret < 0) {
		/* POSIX: posix_spawn returns the errno directly, doesn't set errno. */
		return (int)-ret;
	}
	if (res) *res = pid_out;
	return 0;
}
