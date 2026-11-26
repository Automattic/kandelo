/*
 * The mprotect policy table shared by libkandelo-mprotect.a and the SDK
 * driver.
 *
 * libkandelo-mprotect.a holds the one mprotect implementation,
 * __kandelo_mprotect_with_policy(), and a public mprotect() that applies the
 * truthful policy (every class refused with ENOTSUP). A link that declares
 * the mprotect fiction (sdk/fictions/mprotect.toml) gets a different public
 * mprotect(): the SDK driver generates one per link from the declaration,
 * with a constant policy in this layout, and links it ahead of the library.
 * Both come from one SDK, so the layout cannot drift between them; the
 * version field makes a mismatch fail closed (ENOTSUP) rather than read a
 * different layout.
 */
#ifndef KANDELO_MPROTECT_POLICY_H
#define KANDELO_MPROTECT_POLICY_H

#include <stddef.h>
#include <stdint.h>

#define KANDELO_MPROTECT_POLICY_VERSION 1u

/* What happens to a request in a class the policy names. */
#define KANDELO_MPROTECT_ENOTSUP 0u
#define KANDELO_MPROTECT_ACCEPT_UNENFORCED 1u

struct __kandelo_mprotect_policy {
	uint32_t version;
	/* Requests without PROT_READ: PROT_NONE, and write- or exec-only. */
	uint8_t prot_none;
	/* Requests with PROT_READ but not PROT_WRITE. */
	uint8_t read_only;
	uint16_t reserved;
	/* Largest accepted request in each class, in bytes after page
	 * rounding; 0 means no limit. A larger request is ENOTSUP. */
	uint64_t prot_none_max;
	uint64_t read_only_max;
};

int __kandelo_mprotect_with_policy(void *addr, size_t len, int prot,
	const struct __kandelo_mprotect_policy *policy);

#endif
