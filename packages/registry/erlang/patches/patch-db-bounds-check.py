#!/usr/bin/env python3
"""
Patch erl_db_util.c: Replace ESTACK with fixed array in db_is_fully_bound.

On wasm32, the BEAM allocator's free-list metadata can become corrupt, causing
OOB traps when DESTROY_ESTACK calls erts_free(). This patch replaces the
ESTACK (which dynamically grows via erts_alloc) with a fixed-size local array,
eliminating the allocator from the function entirely.

Also adds wasm memory bounds checking to prevent traps from corrupt Eterm
pointers in ETS tables.

Usage: python3 patch-db-bounds-check.py <path-to-erl_db_util.c>
"""

import sys

PATCH_MARKER = 'wasm_db_fixed_stack'

# The replacement function uses a simple fixed-size array instead of ESTACK.
# 256 entries is sufficient for any reasonable ETS key depth. If a key is
# deeper than 256 levels, we conservatively return true (treat as fully bound).
NEW_FUNC = r'''/* Check if obj is fully bound (contains no variables, underscores, or maps) */
#ifdef __wasm32__
#include <unistd.h>
#include <stdio.h>
/* wasm32: Use fixed local stack to avoid BEAM allocator (which can have corrupt
 * free-list metadata on multi-threaded wasm). Also validate pointers before
 * dereferencing to prevent OOB wasm traps from corrupt Eterm values. */
static const int wasm_db_fixed_stack = 1; /* patch marker */

bool db_is_fully_bound(Eterm node) {
    Eterm stack[256];
    int sp = 0;
    unsigned long mem_max = (unsigned long)__builtin_wasm_memory_size(0) * 65536UL;

    stack[sp++] = node;
    while (sp > 0) {
        node = stack[--sp];
        switch(node & _TAG_PRIMARY_MASK) {
        case TAG_PRIMARY_LIST:
            while (is_list(node)) {
                Eterm *lp = list_val(node);
                if ((unsigned long)lp >= mem_max) {
                    char buf[128];
                    int n = snprintf(buf, sizeof(buf),
                        "[BEAM] db_is_fully_bound: BAD LIST node=0x%08lx addr=0x%08lx\n",
                        (unsigned long)node, (unsigned long)lp);
                    (void)write(STDERR_FILENO, buf, n);
                    return true;
                }
                if (sp >= 255) return true; /* stack full, assume bound */
                stack[sp++] = CAR(lp);
                node = CDR(lp);
            }
            if (sp >= 255) return true;
            stack[sp++] = node;
            break;
        case TAG_PRIMARY_BOXED:
            {
                Eterm *bp = (Eterm*)((node) - TAG_PRIMARY_BOXED);
                if ((unsigned long)bp >= mem_max) {
                    char buf[128];
                    int n = snprintf(buf, sizeof(buf),
                        "[BEAM] db_is_fully_bound: BAD BOXED node=0x%08lx addr=0x%08lx\n",
                        (unsigned long)node, (unsigned long)bp);
                    (void)write(STDERR_FILENO, buf, n);
                    return true;
                }
            }
            if (is_tuple(node)) {
                Eterm *tuple = tuple_val(node);
                int arity = arityval(*tuple);
                while(arity--) {
                    if (sp >= 255) return true;
                    stack[sp++] = *(++tuple);
                }
            } else if (is_map(node)) {
                return false;
            }
            break;
        case TAG_PRIMARY_IMMED1:
            if (node == am_Underscore || db_is_variable(node) >= 0) {
                return false;
            }
            break;
        }
    }
    return true;
}
#else /* !__wasm32__ */
bool db_is_fully_bound(Eterm node) {
    DECLARE_ESTACK(s);

    ESTACK_PUSH(s,node);
    while (!ESTACK_ISEMPTY(s)) {
	node = ESTACK_POP(s);
	switch(node & _TAG_PRIMARY_MASK) {
	case TAG_PRIMARY_LIST:
	    while (is_list(node)) {
		ESTACK_PUSH(s,CAR(list_val(node)));
		node = CDR(list_val(node));
	    }
	    ESTACK_PUSH(s,node);    /* Non wellformed list or [] */
	    break;
	case TAG_PRIMARY_BOXED:
	    if (is_tuple(node)) {
		Eterm *tuple = tuple_val(node);
		int arity = arityval(*tuple);
		while(arity--) {
		    ESTACK_PUSH(s,*(++tuple));
		}
            } else if (is_map(node)) {
                /* Like in Erlang code, "literal" maps in a pattern match any
                 * map that has the given elements, so they must be considered
                 * variable. */
                DESTROY_ESTACK(s);
                return false;
            }
	    break;
	case TAG_PRIMARY_IMMED1:
	    if (node == am_Underscore || db_is_variable(node) >= 0) {
		DESTROY_ESTACK(s);
		return false;
	    }
	    break;
	}
    }
    DESTROY_ESTACK(s);
    return true;
}
#endif /* __wasm32__ */'''

def patch_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()

    if PATCH_MARKER in content:
        print(f"  {filepath}: already patched ({PATCH_MARKER} found)")
        return

    # Find the function by locating its comment + signature
    comment = '/* Check if obj is fully bound (contains no variables, underscores, or maps) */'
    sig = 'bool db_is_fully_bound(Eterm node) {'

    if comment not in content or sig not in content:
        print(f"  ERROR: Could not find db_is_fully_bound function")
        sys.exit(1)

    # Find the start of the comment
    start_idx = content.index(comment)

    # Find the opening brace of the function
    func_start = content.index(sig, start_idx)
    brace_pos = content.index('{', func_start)

    # Find matching closing brace
    brace_count = 0
    end_idx = brace_pos
    for i in range(brace_pos, len(content)):
        if content[i] == '{':
            brace_count += 1
        elif content[i] == '}':
            brace_count -= 1
            if brace_count == 0:
                end_idx = i + 1
                break

    # Replace the function (from comment to closing brace)
    content = content[:start_idx] + NEW_FUNC + content[end_idx:]

    with open(filepath, 'w') as f:
        f.write(content)
    print(f"  Patched {filepath}")


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <path-to-erl_db_util.c>")
        sys.exit(1)
    patch_file(sys.argv[1])
