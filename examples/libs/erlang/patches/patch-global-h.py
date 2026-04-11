#!/usr/bin/env python3
"""Patch global.h for wasm32 ESTACK/WSTACK initialization.

LLVM's wasm32 backend miscompiles aggregate initialization of structs
with pointers to shadow-stack local arrays at -O2. This patch adds
wasm32-specific explicit field-by-field initialization for ESTACK and
WSTACK macros.
"""
import sys

def patch(path):
    with open(path, 'r') as f:
        content = f.read()

    if 'estack_make_default_' in content:
        print(f"  {path}: already patched")
        return

    # 1. Add inline helper + wasm32 ESTACK_DEFAULT_VALUE before original
    old = '#define ESTACK_DEFAULT_VALUE(estack_default_stack_array, alloc_type)'
    new = """#ifdef __wasm32__
static inline ErtsEStack estack_make_default_(Eterm *arr, ErtsAlcType_t at) {
    ErtsEStack s;
    s.start = arr; s.sp = arr;
    s.end = arr + DEF_ESTACK_SIZE;
    s.edefault = arr; s.alloc_type = at;
    return s;
}
#define ESTACK_DEFAULT_VALUE(estack_default_stack_array, alloc_type)    \\
    estack_make_default_((estack_default_stack_array), (alloc_type))
#else
#define ESTACK_DEFAULT_VALUE(estack_default_stack_array, alloc_type)"""
    content = content.replace(old, new, 1)

    # Close #endif after original ESTACK_DEFAULT_VALUE body
    old = '        alloc_type /* alloc_type */                                     \\\n    }\n'
    new = '        alloc_type /* alloc_type */                                     \\\n    }\n#endif\n'
    content = content.replace(old, new, 1)

    # 2. Add wasm32 DECLARE_ESTACK before original
    old = '#define DECLARE_ESTACK(s)'
    new = """#ifdef __wasm32__
#define DECLARE_ESTACK(s)				\\
    Eterm ESTK_DEF_STACK(s)[DEF_ESTACK_SIZE];		\\
    ErtsEStack s;					\\
    (s).start = ESTK_DEF_STACK(s);			\\
    (s).sp = ESTK_DEF_STACK(s);				\\
    (s).end = ESTK_DEF_STACK(s) + DEF_ESTACK_SIZE;	\\
    (s).edefault = ESTK_DEF_STACK(s);			\\
    (s).alloc_type = ERTS_ALC_T_ESTACK
#else
#define DECLARE_ESTACK(s)"""
    content = content.replace(old, new, 1)

    # Close #endif after original DECLARE_ESTACK body
    old = '        ERTS_ALC_T_ESTACK /* alloc_type */\t\t\\\n    }\n'
    new = '        ERTS_ALC_T_ESTACK /* alloc_type */\t\t\\\n    }\n#endif\n'
    content = content.replace(old, new, 1)

    # 3. Add inline helper + wasm32 WSTACK_DEFAULT_VALUE before original
    old = '#define WSTACK_DEFAULT_VALUE(wstack_default_stack_array, alloc_type)'
    new = """#ifdef __wasm32__
static inline ErtsWStack wstack_make_default_(UWord *arr, ErtsAlcType_t at) {
    ErtsWStack s;
    s.wstart = arr; s.wsp = arr;
    s.wend = arr + DEF_WSTACK_SIZE;
    s.wdefault = arr; s.alloc_type = at;
    return s;
}
#define WSTACK_DEFAULT_VALUE(wstack_default_stack_array, alloc_type)    \\
    wstack_make_default_((wstack_default_stack_array), (alloc_type))
#else
#define WSTACK_DEFAULT_VALUE(wstack_default_stack_array, alloc_type)"""
    content = content.replace(old, new, 1)

    # Close #endif after original WSTACK_DEFAULT_VALUE body (uses DEF_ESTACK_SIZE, OTP bug?)
    old_wstack_end = '        alloc_type /* alloc_type */\n    }\n\n#define WSTACK_DECLARE'
    new_wstack_end = '        alloc_type /* alloc_type */\n    }\n#endif\n\n#define WSTACK_DECLARE'
    content = content.replace(old_wstack_end, new_wstack_end, 1)

    # 4. Add wasm32 WSTACK_DECLARE before original
    old = '#define WSTACK_DECLARE(s)'
    new = """#ifdef __wasm32__
#define WSTACK_DECLARE(s)				\\
    UWord WSTK_DEF_STACK(s)[DEF_WSTACK_SIZE];		\\
    ErtsWStack s;					\\
    (s).wstart = WSTK_DEF_STACK(s);			\\
    (s).wsp = WSTK_DEF_STACK(s);			\\
    (s).wend = WSTK_DEF_STACK(s) + DEF_WSTACK_SIZE;	\\
    (s).wdefault = WSTK_DEF_STACK(s);			\\
    (s).alloc_type = ERTS_ALC_T_ESTACK
#else
#define WSTACK_DECLARE(s)"""
    content = content.replace(old, new, 1)

    # Close #endif after original WSTACK_DECLARE body
    old = '        ERTS_ALC_T_ESTACK /* alloc_type */\t\t\\\n    }\n\n#define WSTACK_CHANGE_ALLOCATOR'
    new = '        ERTS_ALC_T_ESTACK /* alloc_type */\t\t\\\n    }\n#endif\n\n#define WSTACK_CHANGE_ALLOCATOR'
    content = content.replace(old, new, 1)

    with open(path, 'w') as f:
        f.write(content)

    print(f"  {path}: patched")

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <path-to-global.h>")
        sys.exit(1)
    patch(sys.argv[1])
