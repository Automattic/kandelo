/* No dynamic linking in Wasm */
#define LDSO_ARCH "wasm64posix"
#define REL_SYMBOLIC    0
#define REL_PLT         0
#define REL_RELATIVE    0
#define REL_OFFSET      0
#define REL_SYM_OR_REL  0
#define REL_DTPMOD      0
#define REL_DTPOFF      0
#define REL_TPOFF       0
#define REL_TPOFF_NEG   0
#define REL_TLSDESC     0
#define CRTJMP(pc,sp) __builtin_unreachable()
